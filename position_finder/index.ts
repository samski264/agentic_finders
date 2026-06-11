/**
 * index.ts — RÉCUPÉRATION DES OFFRES (Apify blackfalcondata/hiringcafe-scraper).
 *
 * On lance l'actor via l'API Apify en mode synchrone (run-sync-get-dataset-items)
 * : un seul appel HTTP qui démarre le run, attend la fin, et renvoie directement
 * les items du dataset (format à plat : jobId, title, company, applyUrl, ...).
 *
 * STOCKAGE LOCAL + DEDUP
 * ----------------------
 * Sortie : positions.json (l'équivalent de results.json côté corpo_finder).
 * On y stocke une LISTE d'offres dédupliquée et FUSIONNÉE à chaque run :
 *   - clé de dedup = jobId (hash de contenu stable) → portalUrl → applyUrl.
 *   - mode incrémental natif de l'actor (incrementalMode) : aux runs suivants,
 *     il ne renvoie/facture que le diff (NEW / UPDATED / REAPPEARED). On upsert
 *     dans le store et on reconstruit la vue complète en local.
 *   - changeType EXPIRED (si emitExpired) → on retire l'offre du store.
 *   - on ajoute _firstSeenLocal / _lastSeenLocal pour l'audit côté nous.
 *
 * NB : on interroge chaque pays SÉPARÉMENT (mode `country`, pas `countries`).
 * En mode `countries`, l'actor applique les filtres seniority/commitment/
 * workplace APRÈS la recherche pays, sur une petite fenêtre → ça vide souvent
 * le résultat. En mono-pays, les filtres sont appliqués pendant la recherche.
 *
 * MULTI-INTITULÉS + FOCUS PAYS
 * ----------------------------
 * On balaie une LISTE d'intitulés (QUERIES, calquée sur le profil) × chaque pays.
 * Pays cibles : FR/CH (focus) puis BE/NL (secondaire). Chaque pays a son PROPRE
 * budget par intitulé (pas de pool partagé qui ferait qu'un pays « mange » tout) :
 *   - FR et CH (FOCUS)  → `--max` offres (défaut 10) chacun ;
 *   - BE et NL          → ~moitié (min 1), pour garder une couverture sans diluer.
 * La dédup par jobId fusionne les recoupements entre pays et intitulés. Chaque
 * offre stockée garde `_query` (l'intitulé qui l'a fait remonter) pour l'audit.
 *
 * Usage :
 *   node --env-file=.env index.ts                         # 23 intitulés, FR/CH pleins + BE/NL réduits
 *   node --env-file=.env index.ts --max 5                 # 5 par intitulé pour FR/CH (BE/NL ~moitié)
 *   node --env-file=.env index.ts --query "founding engineer"  # un seul intitulé
 *   node --env-file=.env index.ts --country FR            # un seul pays (budget plein)
 *   node --env-file=.env index.ts --full                  # re-scrape complet
 *
 * Pré-requis : APIFY_TOKEN dans .env (https://console.apify.com/account/integrations).
 * Pré-requis : Node 24+ (exécution .ts native).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(HERE, "positions.json");

const ACTOR_ID = "blackfalcondata~hiringcafe-scraper";

// --- CLI -------------------------------------------------------------------- //
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// Cible par défaut : calquée sur le profil (junior+/mid, full time, hybride/présentiel).
// FR/CH d'abord (focus), puis BE/NL (secondaire).
const DEFAULT_COUNTRIES = ["FR", "CH", "BE", "NL"];
const maxN = flag("--max") ? Number(flag("--max")) : 10; // budget plein (FR/CH) PAR intitulé
const singleCountry = flag("--country");
const countries = singleCountry ? [singleCountry] : DEFAULT_COUNTRIES;

// Pays mis en avant : ils reçoivent le budget plein `maxN` par intitulé.
const FOCUS = new Set(["FR", "CH"]);
// Budget par (intitulé × pays) : focus = plafond plein, secondaire = ~moitié (min 1).
// Un `--country` explicite reçoit toujours le budget plein.
const budgetFor = (c: string): number =>
  singleCountry || FOCUS.has(c) ? maxN : Math.max(1, Math.round(maxN / 2));

// Intitulés à balayer (le même poste sous tous ses noms, cf. cv_interpolation.md).
// --query "x" force un intitulé unique.
const DEFAULT_QUERIES = [
  "Product Engineer",
  "Design Engineer",
  "Product Design Engineer",
  "Founding Engineer",
  "Founding Product Engineer",
  "Full-Stack Engineer",
  "Frontend Engineer",
  "Senior Frontend Engineer",
  "Software Engineer Frontend",
  "React Engineer",
  "Next.js Engineer",
  "UI Engineer",
  "UI/UX Engineer",
  "Growth Engineer",
  "Solutions Engineer",
  "Forward-Deployed Engineer",
  "Prototyping Engineer",
  "R&D Engineer",
  "Technical Co-founder",
  "Creative Technologist",
  "Creative Developer",
  "Product Designer",
  "UX Designer",
];
const queries = flag("--query") ? [flag("--query")!] : DEFAULT_QUERIES;

// Champs communs (filtres + options de sortie). `country` et `query` sont injectés par appel.
const base = {
  seniorityLevels: ["Entry Level", "Mid Level"],
  commitmentTypes: ["Full Time"],
  workplaceTypes: ["Hybrid", "Onsite"],
  onlyTransparentSalaries: false,
  includeDetails: true,
  outputMode: "full",
  descriptionFormat: "all",
  maxResults: maxN,
  // Incrémental : on ne paie/reçoit que le diff aux runs suivants.
  // --full force un re-scrape complet (incrementalMode off).
  incrementalMode: !has("--full"),
  emitUnchanged: false,
  emitExpired: false,
  skipReposts: false,
};

// --- Type (champs utiles ; on garde le brut pour le reste) ------------------ //
type Position = {
  jobId?: string;
  title?: string;
  company?: string;
  companyName?: string;
  location?: string;
  applyUrl?: string;
  portalUrl?: string;
  postedDate?: string;
  changeType?: "NEW" | "UPDATED" | "UNCHANGED" | "REAPPEARED" | "EXPIRED" | null;
  // métadonnées locales (ajoutées par nous, pas par l'actor)
  _firstSeenLocal?: string;
  _lastSeenLocal?: string;
  _query?: string; // intitulé qui a fait remonter l'offre
  [key: string]: unknown;
};

type Store = {
  actor: string;
  generated_at: string;
  queries: string[];
  count: number;
  positions: Position[];
};

/** Clé de dedup : jobId (hash de contenu) → portalUrl → applyUrl → titre+boîte. */
const dedupKey = (p: Position): string =>
  p.jobId ??
  p.portalUrl ??
  p.applyUrl ??
  `t:${(p.title ?? "").toLowerCase()}|${(p.company ?? p.companyName ?? "").toLowerCase()}`;

const companyOf = (p: Position) => p.company ?? p.companyName ?? "?";

async function loadStore(): Promise<Store | null> {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8")) as Store;
  } catch {
    return null;
  }
}

/** Un run mono-(intitulé × pays) via run-sync-get-dataset-items. */
async function fetchOne(
  token: string,
  query: string,
  country: string,
  limit: number,
): Promise<Position[]> {
  const endpoint = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, query, country, maxResults: limit }),
  });
  if (!res.ok) throw new Error(`Apify ${res.status} (${query} / ${country}): ${await res.text()}`);
  const items = (await res.json()) as Position[];
  for (const it of items) it._query = query; // traçabilité de l'intitulé source
  return items;
}

/** Boucle intitulés × pays ; budget PROPRE par pays (FR/CH pleins, BE/NL réduits). */
async function fetchPositions(token: string): Promise<Position[]> {
  const all: Position[] = [];
  for (const q of queries) {
    const seen = new Set<string>();
    const batch: Position[] = [];
    const perCountry: string[] = [];
    for (const c of countries) {
      const need = budgetFor(c);
      const items = await fetchOne(token, q, c, need);
      let kept = 0;
      for (const it of items) {
        const key = dedupKey(it);
        if (seen.has(key)) continue;
        seen.add(key);
        batch.push(it);
        kept++;
      }
      perCountry.push(`${c}:${kept}/${need}`);
    }
    all.push(...batch);
    console.error(`  · "${q}": ${batch.length} offres (${perCountry.join(" ")})`);
  }
  return all;
}

async function main() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      "APIFY_TOKEN manquant. Ajoute-le dans position_finder/.env " +
        "(https://console.apify.com/account/integrations).",
    );
  }

  const existing = await loadStore();
  const runCount = queries.length * countries.length;
  const budgets = countries.map((c) => `${c}:${budgetFor(c)}`).join(" ");
  console.error(
    `${queries.length} intitulé(s) × ${countries.join("/")} = ${runCount} run(s) | budgets/intitulé ${budgets} | ` +
      `${base.incrementalMode ? "incrémental" : "FULL re-scrape"} | store: ${existing?.positions.length ?? 0} offres`,
  );

  const fetched = await fetchPositions(token);

  // Fusion / dedup sur la base existante.
  const now = new Date().toISOString();
  const merged = new Map<string, Position>();
  for (const p of existing?.positions ?? []) merged.set(dedupKey(p), p);
  const before = merged.size;

  let added = 0,
    updated = 0,
    expired = 0;
  for (const p of fetched) {
    const key = dedupKey(p);
    if (p.changeType === "EXPIRED") {
      if (merged.delete(key)) expired++;
      continue;
    }
    const prev = merged.get(key);
    merged.set(key, {
      ...p,
      _firstSeenLocal: prev?._firstSeenLocal ?? now,
      _lastSeenLocal: now,
    });
    if (prev) updated++;
    else added++;
  }

  const positions = [...merged.values()];
  const store: Store = {
    actor: ACTOR_ID,
    generated_at: now,
    queries,
    count: positions.length,
    positions,
  };
  await writeFile(OUT_FILE, JSON.stringify(store, null, 2), "utf8");

  console.error(
    `\nOK -> ${OUT_FILE}\n` +
      `  reçu ${fetched.length} | +${added} nouvelles, ${updated} maj, ${expired} expirées | ` +
      `total ${positions.length} (était ${before}).`,
  );
  for (const p of positions.slice(0, 10)) {
    console.error(`  · ${p.title ?? "?"} — ${companyOf(p)} (${p.location ?? "?"})`);
  }
  if (positions.length > 10) console.error(`  … +${positions.length - 10} autres`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
