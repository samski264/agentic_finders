/**
 * score.ts — SCORING des offres via OLLAMA (LLM local). Le score de
 * compatibilité 0-100 est donné par le modèle, pas par des mots-clés.
 *
 * Pipeline :
 *   1. Gate déterministe DUR (gratuit, avant tout appel LLM) :
 *        - zone : présentiel/hybride en CH / FR / BE / NL
 *        - PAS DE REMOTE (workplace_type = Remote → drop)
 *   2. Pour les survivants : on envoie le PROFIL complet (profile/cv.md +
 *      profile/cv_interpolation.md) + l'offre résumée à Ollama, qui renvoie un
 *      JSON { compatibility, verdict, pros, cons, reason }.
 *   3. tier 1 (>=80) / tier 2 (>=KEEP) ; en dessous = dropped_score.
 *
 * Sortie : scored.json (trié par compatibilité décroissante).
 *
 * Usage :
 *   node score.ts                                  # positions.json -> scored.json
 *   node score.ts --in positions.json --out scored.json [--keep-only] [--min 60]
 *   node score.ts --model qwen3.6:35b --concurrency 2
 *   node score.ts --rescore                        # ignore le cache (re-LLM tout)
 *
 * Pré-requis : Ollama lancé (http://localhost:11434). Modèles dispos :
 *   qwen3.6:35b (défaut, rapide), gpt-oss:120b (lourd, sature la VRAM), gemma4:26b.
 *   NB : `think:false` est envoyé pour couper le mode "thinking" (sinon très lent).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------- //
// PROFIL : zones valides (filtre dur). Remote exclu (cf. demande).
// --------------------------------------------------------------------------- //
const HOME_COUNTRIES = ["CH", "FR", "BE", "NL"] as const;

// --------------------------------------------------------------------------- //
// Config Ollama
// --------------------------------------------------------------------------- //
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
let OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.6:35b";
let CONCURRENCY = 3;
let KEEP_THRESHOLD = 50; // compatibilité minimale gardée (0-100) — flexible, réglable via --min
const TIER1_THRESHOLD = 75;

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //
type Gates = { zone_ok: boolean; not_remote: boolean };
const GATES = ["zone_ok", "not_remote"] as const;

type LlmVerdict = {
  compatibility: number; // 0-100
  verdict: "strong" | "possible" | "weak";
  reason: string;
  pros: string[];
  cons: string[];
};

type RawPosition = Record<string, any>;

type Scored = {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string;
  url: string;
  seniority: string;
  workplace_type: string;
  nb_employees: number | null;
  funding: string;
  posted: string;
  posted_days_ago: number | null;
  gates: Gates;
  compatibility: number | null;
  verdict: string | null;
  reason: string;
  pros: string[];
  cons: string[];
  tier: number | null;
  status: "kept" | "dropped_gate" | "dropped_score" | "error";
  drop_reason?: string[];
};

// --------------------------------------------------------------------------- //
// Extraction des champs
// --------------------------------------------------------------------------- //
const stripHtml = (s: string): string =>
  s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

/** Schéma plat hiring.cafe (blackfalcondata) : pays de travail (normalisés). */
function countriesOf(p: RawPosition): string[] {
  const list = [
    ...(p.workplaceCountries ?? []),
    ...(p.locationNormalized?.countries ?? []),
  ];
  return list.map((c: string) => String(c).toUpperCase());
}

const isRemote = (p: RawPosition): boolean =>
  String(p.workplaceType ?? "").toLowerCase().includes("remote") ||
  p.locationNormalized?.remote === true ||
  p.isWorkplaceWorldwideOk === true;

function postedDaysAgo(p: RawPosition): number | null {
  const d = p.postedDate ?? p.firstSeenAt ?? p.scrapedAt;
  if (!d) return null;
  const ms = Date.parse(String(d));
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
}

function flatten(p: RawPosition): Omit<
  Scored,
  "gates" | "compatibility" | "verdict" | "reason" | "pros" | "cons" | "tier" | "status"
> {
  const company = p.company ?? p.companyName ?? p.source ?? "?";
  const fundParts = [p.companyFundingType, p.companyFundingYear, p.companyFundingAmount]
    .filter(Boolean)
    .join(" ");
  return {
    id: String(p.jobId ?? p.portalUrl ?? p.applyUrl ?? ""),
    title: p.title ?? "?",
    company,
    location: p.location ?? p.locationNormalized?.display ?? (p.workplaceCities ?? [])[0] ?? "?",
    country: countriesOf(p)[0] ?? "?",
    url: p.applyUrl ?? p.portalUrl ?? "",
    seniority: p.seniorityLevel ?? "?",
    workplace_type: p.workplaceType ?? "?",
    nb_employees: p.companyEmployeeCount ?? null,
    funding: fundParts || "—",
    posted: p.postedDate ?? "",
    posted_days_ago: postedDaysAgo(p),
  };
}

// --------------------------------------------------------------------------- //
// Gate déterministe : zone + pas de remote
// --------------------------------------------------------------------------- //
function deriveGates(p: RawPosition): Gates {
  const countries = countriesOf(p);
  const not_remote = !isRemote(p);
  const zone_ok = countries.some((c) => (HOME_COUNTRIES as readonly string[]).includes(c));
  return { zone_ok, not_remote };
}
const gatesPass = (g: Gates): boolean => GATES.every((k) => g[k] === true);

// --------------------------------------------------------------------------- //
// Résumé compact de l'offre pour le LLM (limite les tokens)
// --------------------------------------------------------------------------- //
function jobSummary(p: RawPosition, base: ReturnType<typeof flatten>): string {
  const descRaw = p.descriptionMarkdown ?? p.description ?? p.descriptionHtml ?? "";
  const desc = stripHtml(String(descRaw)).slice(0, 1800);
  const tools = (p.technicalTools ?? p.technicalToolsNormalized ?? []) as string[];
  const lines = [
    `Titre: ${base.title}`,
    `Entreprise: ${base.company}`,
    `Lieu: ${base.location} (${base.country}) — ${base.workplace_type}`,
    `Séniorité: ${base.seniority}${p.roleType ? ` · ${p.roleType}` : ""}${
      p.minYearsExperience != null ? ` · ${p.minYearsExperience}+ ans` : ""
    }`,
    `Effectif: ${base.nb_employees ?? "?"} (${p.companySizeBucket ?? "?"}) · Fondée: ${p.companyYearFounded ?? "?"} · Levée: ${base.funding} · Type: ${p.companyOrganizationType ?? "?"}`,
    `Secteur: ${p.companySector ?? "?"} — ${(p.companyIndustries ?? []).join(", ")}`,
    p.companyTagline ? `Pitch boîte: ${p.companyTagline}` : "",
    tools?.length ? `Outils: ${tools.join(", ")}` : "",
    p.requirementsSummary ? `Exigences: ${p.requirementsSummary}` : "",
    `Description: ${desc}`,
  ];
  return lines.filter(Boolean).join("\n");
}

// --------------------------------------------------------------------------- //
// Appel Ollama (chat, format JSON forcé, température 0)
// --------------------------------------------------------------------------- //
const SYSTEM_PROMPT = `Tu es un évaluateur de compatibilité poste/candidat, factuel mais OUVERT et flexible.
On te donne le PROFIL d'un candidat (CV + notes d'interprétation) et une OFFRE d'emploi.
Tu renvoies UNIQUEMENT un objet JSON, sans texte autour, de la forme :
{
  "compatibility": <entier 0-100>,
  "verdict": "strong" | "possible" | "weak",
  "reason": "<1 phrase concise en français>",
  "pros": ["<point fort 1>", "..."],
  "cons": ["<point faible 1>", "..."]
}

PHILOSOPHIE : récompense le POTENTIEL de fit, pas seulement le match littéral. Le candidat
est un profil HYBRIDE rare : ingénieur produit qui code (TS/JS/React/Next/Node/AI/3D) ET qui
designe (Figma, design d'interface, direction artistique, 3D temps réel). Beaucoup d'annonces
ne nomment pas ce profil exactement : sois généreux dès qu'un poste touche son terrain.

DEUX AVANTAGES PRIORITAIRES (à valoriser fort dans le score) :
1. OWNERSHIP : tout signal de founding / 0-to-1 / end-to-end / "own the product" / autonomie /
   généraliste / "wear many hats" / petite équipe / from scratch → bonus net (+10 à +20).
2. CROISEMENT ENGINEERING × DESIGN : tout poste à l'intersection code+design (design engineer,
   product engineer, UI/UX engineer, creative developer/technologist, product designer qui code,
   front-end orienté design, prototyping, 3D/WebGL/configurateur) → bonus net (+10 à +20).
   C'est le cœur de cible du candidat, même si la boîte est un peu plus grande ou la stack diffère.

Barème de compatibility (flexible, généreux sur le potentiel) :
- 80-100 (strong) : poste qui combine ownership ET croisement code/design, stack web moderne ou
  AI/3D, séniorité junior→mid ou non précisée, vraie surface produit. Le rêve.
- 55-79 (possible) : bon terrain mais un signal manque ou diverge (stack différente mais
  transposable, stade un peu avancé, séniorité un peu haute, soit code soit design dominant mais
  pas les deux). En cas de doute raisonnable, reste dans cette bande plutôt que de descendre.
- 0-54 (weak) : vrai hors-sujet. Mets bas si : ingénierie mécanique/matériaux/hardware/chimie sans
  logiciel, conseil/ESN pur, poste purement managérial/senior staff sans hands-on, ops/support,
  marketing/vente sans produit. Mais n'enterre PAS un poste juste parce qu'il manque un critère.

Juge le FOND (métier, stack, croisement design, ownership, stade). Ignore la zone (déjà filtrée).
Ne pénalise PAS l'absence d'info (séniorité/stade non précisés ≠ mauvais).`;

async function scoreWithOllama(profile: string, jobText: string): Promise<LlmVerdict> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      think: false, // coupe le mode "thinking" (qwen3/gpt-oss) qui ralentit énormément
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `### PROFIL DU CANDIDAT\n${profile}\n\n### OFFRE À ÉVALUER\n${jobText}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "";
  const parsed = JSON.parse(content) as Partial<LlmVerdict>;
  const compatibility = Math.max(0, Math.min(100, Math.round(Number(parsed.compatibility ?? 0))));
  return {
    compatibility,
    verdict: parsed.verdict ?? (compatibility >= 75 ? "strong" : compatibility >= 55 ? "possible" : "weak"),
    reason: String(parsed.reason ?? ""),
    pros: Array.isArray(parsed.pros) ? parsed.pros.map(String) : [],
    cons: Array.isArray(parsed.cons) ? parsed.cons.map(String) : [],
  };
}

const tierFor = (c: number): number | null => (c >= TIER1_THRESHOLD ? 1 : c >= KEEP_THRESHOLD ? 2 : null);

// --------------------------------------------------------------------------- //
// Évaluation d'une offre (gate déterministe, puis LLM si gate OK)
// --------------------------------------------------------------------------- //
async function evaluate(p: RawPosition, profile: string, cache: Map<string, Scored>): Promise<Scored> {
  const base = flatten(p);
  const gates = deriveGates(p);

  if (!gatesPass(gates)) {
    return {
      ...base, gates, compatibility: null, verdict: null, reason: "", pros: [], cons: [],
      tier: null, status: "dropped_gate", drop_reason: GATES.filter((k) => gates[k] !== true),
    };
  }

  const cached = cache.get(base.id);
  if (cached && cached.compatibility != null) {
    const tier = tierFor(cached.compatibility);
    return { ...base, gates, compatibility: cached.compatibility, verdict: cached.verdict,
      reason: cached.reason, pros: cached.pros, cons: cached.cons, tier,
      status: tier === null ? "dropped_score" : "kept" };
  }

  try {
    const v = await scoreWithOllama(profile, jobSummary(p, base));
    const tier = tierFor(v.compatibility);
    return { ...base, gates, compatibility: v.compatibility, verdict: v.verdict, reason: v.reason,
      pros: v.pros, cons: v.cons, tier, status: tier === null ? "dropped_score" : "kept" };
  } catch (e) {
    return { ...base, gates, compatibility: null, verdict: null,
      reason: `erreur LLM: ${(e as Error).message}`, pros: [], cons: [], tier: null, status: "error" };
  }
}

/** Pool de concurrence simple. */
async function mapPool<T, R>(items: T[], limit: number, fn: (it: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag("--model")) OLLAMA_MODEL = flag("--model")!;
if (flag("--concurrency")) CONCURRENCY = Math.max(1, Number(flag("--concurrency")));
if (flag("--min")) KEEP_THRESHOLD = Math.max(0, Number(flag("--min")));

const inPath = flag("--in") ?? resolve(HERE, "positions.json");
const outPath = flag("--out") ?? resolve(HERE, "scored.json");

async function loadProfile(): Promise<string> {
  const dir = resolve(HERE, "profile");
  const parts: string[] = [];
  for (const f of ["cv.md", "cv_interpolation.md"]) {
    try {
      parts.push(await readFile(resolve(dir, f), "utf8"));
    } catch {
      /* fichier optionnel */
    }
  }
  if (!parts.length) throw new Error(`Aucun profil trouvé dans ${dir} (cv.md / cv_interpolation.md).`);
  return parts.join("\n\n---\n\n");
}

async function loadCache(): Promise<Map<string, Scored>> {
  if (has("--rescore")) return new Map();
  try {
    const prev = JSON.parse(await readFile(outPath, "utf8")) as Scored[];
    return new Map(prev.filter((c) => c.compatibility != null).map((c) => [c.id, c]));
  } catch {
    return new Map();
  }
}

const profile = await loadProfile();
const raw = JSON.parse(await readFile(inPath, "utf8"));
const positions: RawPosition[] = Array.isArray(raw) ? raw : (raw.positions ?? []);

// Gate d'abord : on n'appelle le LLM que sur les offres en zone & non-remote.
const cache = await loadCache();
const gatePass = positions.filter((p) => gatesPass(deriveGates(p)));
console.error(
  `${positions.length} offres | ${gatePass.length} passent le gate (zone ${HOME_COUNTRIES.join("/")}, no remote) | ` +
    `LLM: ${OLLAMA_MODEL} @ conc ${CONCURRENCY} | cache: ${cache.size}`,
);

let done = 0;
const res = await mapPool(positions, CONCURRENCY, async (p) => {
  const r = await evaluate(p, profile, cache);
  if (r.status !== "dropped_gate") console.error(`  [${++done}/${gatePass.length}] ${r.compatibility ?? "ERR"} — ${r.title} @ ${r.company}`);
  return r;
});

res.sort((a, b) => (b.compatibility ?? -1) - (a.compatibility ?? -1) || (a.tier ?? 9) - (b.tier ?? 9));
// On écrit TOUJOURS les résultats complets : scored.json sert aussi de cache LLM.
// Le filtrage "kept" est la responsabilité de shortlist.ts (--keep-only ici n'est
// plus qu'un alias historique sans effet sur le fichier).
await writeFile(outPath, JSON.stringify(res, null, 2), "utf8");

const kept = res.filter((c) => c.status === "kept").length;
const dg = res.filter((c) => c.status === "dropped_gate").length;
const ds = res.filter((c) => c.status === "dropped_score").length;
const err = res.filter((c) => c.status === "error").length;
console.error(
  `\nOK -> ${outPath}\n  ${res.length} évaluées | ${kept} gardées, ${dg} drop(gate), ${ds} drop(score)` +
    `${err ? `, ${err} erreur(s)` : ""} | seuil ${KEEP_THRESHOLD} (tier1>=${TIER1_THRESHOLD})`,
);
for (const c of res.filter((c) => c.status === "kept").slice(0, 10)) {
  console.error(`  · [${c.compatibility}/100 t${c.tier}] ${c.title} — ${c.company} (${c.location})`);
}
