/**
 * enrich.ts — ENRICHISSEMENT LLM (le maillon entre results.json et score.ts).
 *
 * Pour CHAQUE candidat de results.json, on demande à gpt-oss:120b (servi par
 * ollama en local) de juger, EN INTERPOLANT avec le profil de /profile :
 *   - 3 gates  : zone_ok, stade_ok, produit_ok
 *   - 5 critères 0/1 : produit_pertinent, culture_builder, stack_match,
 *                      decideur_joignable, signal_frais  (+ why + source)
 *
 * Le LLM juge/extrait ; il NE score PAS (c'est score.ts qui somme, déterministe).
 * Sortie : enrichis.json (format attendu par score.ts), écrit INCRÉMENTALEMENT
 * → relançable : un candidat déjà enrichi n'est pas refait.
 *
 * On parle à ollama via l'API HTTP /api/generate (le CLI `ollama run` se fige
 * en mode piped ; l'API sert exactement le même modèle gpt-oss:120b).
 *
 * Usage :
 *   node enrich.ts                       # results.json -> enrichis.json (strict)
 *   node enrich.ts --in results.json --out enrichis.json [--limit N] [--force]
 *   node enrich.ts --loose [--team-max 80]   # mode LARGE : + d'options
 *   node enrich.ts && node score.ts --in enrichis.json --keep-only | node shortlist.ts
 *
 * Réglages "plus d'options" :
 *   --loose / --wide  : stade jusqu'à série B, critères généreux, doute -> 1.
 *   --team-max N      : effectif max toléré pour stade_ok (strict 30, large 80).
 *   (côté score : node score.ts --min 2  pour baisser le seuil de garde.)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.6:35b";
const KEEP_ALIVE = "30m";

// --- CLI -------------------------------------------------------------------- //
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const inPath = resolve(HERE, flag("--in") ?? "results.json");
const outPath = resolve(HERE, flag("--out") ?? "enrichis.json");
const limit = flag("--limit") ? Number(flag("--limit")) : Infinity;
const force = has("--force");
// Mode "large" : assouplit le gate stade + l'attribution des critères pour
// remonter plus d'options (au prix d'un peu de précision). --loose ou --wide.
const loose = has("--loose") || has("--wide");
// Taille d'équipe max tolérée pour stade_ok (défaut 30 ; 80 en mode large).
const teamMax = flag("--team-max")
  ? Number(flag("--team-max"))
  : loose
    ? 80
    : 30;

type Citation = { url?: string; title?: string; excerpts?: string[] };
type Basis = { field?: string; citations?: Citation[] };
type RawCandidate = {
  name: string;
  url?: string | null;
  description?: string | null;
  output?: {
    zone_check?: { is_matched?: boolean; value?: string };
    software_product_check?: { is_matched?: boolean; value?: string };
  } | null;
  basis?: Basis[] | null;
};

type Crit = { value: 0 | 1; why: string; source: string };
type Enriched = {
  name: string;
  url: string;
  city: string;
  source: string;
  gates: { zone_ok: boolean; stade_ok: boolean; produit_ok: boolean };
  criteria: {
    produit_pertinent: Crit;
    culture_builder: Crit;
    stack_match: Crit;
    decideur_joignable: Crit;
    signal_frais: Crit;
  };
  fit_reason?: string;
};

const dedupKey = (c: { name: string; url?: string | null }) =>
  c.url ? c.url.replace(/\/+$/, "").toLowerCase() : `name:${c.name.toLowerCase()}`;

/** Aplati les preuves (basis excerpts) en texte lisible, borné. */
function evidenceText(c: RawCandidate): string {
  const out: string[] = [];
  for (const b of c.basis ?? []) {
    for (const cit of b.citations ?? []) {
      const ex = (cit.excerpts ?? []).join(" · ");
      if (ex) out.push(`[${b.field ?? "?"}] (${cit.url ?? ""}) ${ex}`);
    }
  }
  return out.join("\n").slice(0, 6000);
}

function buildSystem(profile: string): string {
  const stadeRule = loose
    ? `stade_ok : true si seed → série B ET équipe < ~${teamMax}. FALSE seulement pour grand groupe coté/multinationale, ou entreprise clairement enterprise (>~${teamMax} pers.). En cas de doute sur le stade, mets true (on élargit volontairement).`
    : `stade_ok : true si seed → série A ET équipe < ~${teamMax}. FALSE si scale-up série B+, grand groupe, entreprise rachetée/acquise, effectif élevé. (Le candidat est junior+/mid, ~2 ans d'XP : pas de boîtes qui ne cherchent que du senior/staff.)`;
  const critNote = loose
    ? `MODE LARGE : sois généreux. Mets 1 dès qu'il y a un indice raisonnable (pas seulement une preuve formelle). En cas de doute crédible, préfère 1 à 0.`
    : `Mets 1 UNIQUEMENT avec une preuve explicite dans les infos fournies, sinon 0.`;
  return `Tu es un assistant de recrutement qui évalue des entreprises POUR UN CANDIDAT PRÉCIS.
Tu juges et extrais des faits ; tu ne calcules AUCUN score (un autre programme le fait).

=== PROFIL DU CANDIDAT (référence absolue, n'invente rien au-delà) ===
${profile}
=== FIN DU PROFIL ===

Pour l'entreprise fournie, renvoie STRICTEMENT un objet JSON (aucun texte autour) :
{
  "gates": { "zone_ok": bool, "stade_ok": bool, "produit_ok": bool },
  "criteria": {
    "produit_pertinent":  { "value": 0|1, "why": "...", "source": "url" },
    "culture_builder":    { "value": 0|1, "why": "...", "source": "url" },
    "stack_match":        { "value": 0|1, "why": "...", "source": "url" },
    "decideur_joignable": { "value": 0|1, "why": "...", "source": "url" },
    "signal_frais":       { "value": 0|1, "why": "...", "source": "url" }
  },
  "city": "ville si connue sinon \\"\\"",
  "fit_reason": "1 phrase: pourquoi (ou pas) un fit pour CE candidat"
}

GATES (un seul false = l'entreprise sera éliminée plus tard) :
- zone_ok : siège ou bureau en Suisse / France / Belgique / Pays-Bas / Luxembourg, OU remote-first dans l'UE.
- produit_ok : le cœur de l'offre est un vrai produit logiciel (web app, IA, 3D/WebGL/temps réel, outil créatif/design, dev tooling). FORCE false pour : agence, studio de démos vitrine, conseil/ESN pur, hardware sans surface logicielle.
- ${stadeRule}

CRITÈRES 0/1 — ${critNote} "source" = l'URL de la preuve.
- produit_pertinent : interface riche / vraie complexité technique (IA, 3D, infra) alignée avec le profil.
- culture_builder : signaux founding / ownership / 0-to-1 / petite équipe / "wear many hats".
- stack_match : stack proche du candidat (TypeScript, React, Next.js, Node, Three.js/WebGL, IA/LLM/embeddings).
- decideur_joignable : fondateur ou CTO identifiable via source ouverte (site, presse) — JAMAIS LinkedIn/X.
- signal_frais : levée de fonds OU poste ouvert daté de moins de ~60 jours.

Interpole avec le profil (le fichier d'interpolation élargit ce qui compte comme match) mais ne contredis jamais les faits fournis. Pas de preuve → 0. Réponds en JSON pur.`;
}

function buildPrompt(c: RawCandidate): string {
  const zone = c.output?.zone_check;
  const prod = c.output?.software_product_check;
  return `ENTREPRISE : ${c.name}
SITE : ${c.url ?? "?"}

DESCRIPTION :
${c.description ?? "(aucune)"}

VERDICTS COLLECTE (indicatifs, à confirmer) :
- zone_check.is_matched = ${zone?.is_matched ?? "?"} (${zone?.value ?? ""})
- software_product_check.is_matched = ${prod?.is_matched ?? "?"} (${prod?.value ?? ""})

PREUVES (extraits sourcés) :
${evidenceText(c) || "(aucune)"}

Évalue cette entreprise pour le candidat et renvoie l'objet JSON demandé.`;
}

async function callOllama(system: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      system,
      prompt,
      stream: false,
      // think:false → qwen3 saute la phase de raisonnement (réponse ~10x plus
      // rapide). NB: pas de format:"json" (il casse la sortie harmony de
      // gpt-oss) — on force le JSON par le prompt et on l'extrait nous-mêmes.
      think: false,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

/** Récupère le 1er objet JSON équilibré dans un texte (robustesse). */
function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("pas de JSON dans la réponse");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("JSON non équilibré");
}

const bool = (v: unknown) => v === true;
const bit = (v: unknown): 0 | 1 => (v === 1 || v === true || v === "1" ? 1 : 0);
const crit = (o: any): Crit => ({
  value: bit(o?.value),
  why: typeof o?.why === "string" ? o.why : "",
  source: typeof o?.source === "string" ? o.source : "",
});

function normalize(c: RawCandidate, j: any): Enriched {
  const cr = j?.criteria ?? {};
  return {
    name: c.name,
    url: c.url ?? "",
    city: typeof j?.city === "string" ? j.city : "",
    source: c.url ?? "",
    gates: {
      zone_ok: bool(j?.gates?.zone_ok),
      stade_ok: bool(j?.gates?.stade_ok),
      produit_ok: bool(j?.gates?.produit_ok),
    },
    criteria: {
      produit_pertinent: crit(cr.produit_pertinent),
      culture_builder: crit(cr.culture_builder),
      stack_match: crit(cr.stack_match),
      decideur_joignable: crit(cr.decideur_joignable),
      signal_frais: crit(cr.signal_frais),
    },
    fit_reason: typeof j?.fit_reason === "string" ? j.fit_reason : "",
  };
}

// --------------------------------------------------------------------------- //
async function main() {
  const store = JSON.parse(await readFile(inPath, "utf8"));
  const candidates: RawCandidate[] = Array.isArray(store) ? store : store.candidates ?? [];

  const cvParts = await Promise.all(
    ["profile/cv.md", "profile/cv_interpolation.md"].map((p) =>
      readFile(resolve(HERE, p), "utf8").catch(() => ""),
    ),
  );
  const profile = cvParts.filter(Boolean).join("\n\n");
  if (!profile) throw new Error("profil introuvable dans ./profile");
  const system = buildSystem(profile);

  // reprise : recharge l'existant, indexé par clé de dédup
  const done = new Map<string, Enriched>();
  if (!force) {
    try {
      const prev: Enriched[] = JSON.parse(await readFile(outPath, "utf8"));
      for (const e of prev) done.set(dedupKey(e), e);
    } catch {}
  }

  const todo = candidates.filter((c) => !done.has(dedupKey(c))).slice(0, limit);
  console.error(
    `${candidates.length} candidats | déjà faits ${done.size} | à enrichir ${todo.length} | modèle ${MODEL} | mode ${loose ? `LARGE (team<${teamMax})` : "strict"}`,
  );

  let i = 0;
  for (const c of todo) {
    i++;
    const t0 = Date.now();
    try {
      const raw = await callOllama(system, buildPrompt(c));
      const enriched = normalize(c, extractJson(raw));
      done.set(dedupKey(c), enriched);
      const g = enriched.gates;
      const sc = Object.values(enriched.criteria).filter((x) => x.value === 1).length;
      console.error(
        `[${i}/${todo.length}] ${c.name} — gates z${+g.zone_ok}/s${+g.stade_ok}/p${+g.produit_ok} crit ${sc}/5 (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
    } catch (e) {
      console.error(`[${i}/${todo.length}] ${c.name} — ÉCHEC: ${(e as Error).message}`);
    }
    // écriture incrémentale (relançable même si interrompu)
    await writeFile(outPath, JSON.stringify([...done.values()], null, 2), "utf8");
  }
  console.error(`OK -> ${outPath} | ${done.size} candidats enrichis au total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
