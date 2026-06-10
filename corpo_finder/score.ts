/**
 * score.ts — SCORING déterministe (étape 5 du pipe). AUCUN LLM ici.
 *
 * Entrée : candidats déjà enrichis (gates + 5 critères 0/1), OU directement le
 * results.json de findall (les gates zone/produit sont alors mappés depuis
 * output.*.is_matched ; stade + critères doivent être fournis par l'agent).
 * Sortie : mêmes candidats, gardés ou droppés, avec score + tier calculés.
 *
 * Règle : gates avant le score. score = somme des 5 critères /5. Garde >=3.
 *         tier 1 (4-5) / 2 (3). Pur, déterministe, testable.
 *
 * Usage :
 *   node score.ts --in enrichis.json [--out scored.json] [--keep-only]
 *   cat enrichis.json | node score.ts
 *   node score.ts --self-test
 */
import { readFile, writeFile } from "node:fs/promises";

type Crit = { value: number; why?: string; source?: string };
type Gates = { zone_ok?: boolean; stade_ok?: boolean; produit_ok?: boolean };
type FindallCheck = { is_matched?: boolean };

type Candidate = {
  name: string;
  url?: string | null;
  city?: string;
  source?: string;
  gates?: Gates;
  stade_ok?: boolean; // fallback si gates absent et qu'on part du results.json findall
  criteria?: Record<string, Crit>;
  output?: { zone_check?: FindallCheck; software_product_check?: FindallCheck } | null;
  [k: string]: unknown;
};

type Scored = Candidate & {
  score: number | null;
  tier: number | null;
  status: "kept" | "dropped_gate" | "dropped_score";
  drop_reason?: string[];
};

const GATES = ["zone_ok", "stade_ok", "produit_ok"] as const;
const CRITERIA = [
  "produit_pertinent",
  "culture_builder",
  "stack_match",
  "decideur_joignable",
  "signal_frais",
] as const;
const KEEP_THRESHOLD = 3;

/** gates explicites prioritaires ; sinon mappe zone/produit depuis le JSON findall. */
function deriveGates(c: Candidate): Gates {
  if (c.gates) return c.gates;
  const o = c.output ?? undefined;
  return {
    zone_ok: o?.zone_check?.is_matched === true,
    produit_ok: o?.software_product_check?.is_matched === true,
    stade_ok: c.stade_ok === true,
  };
}

const gatesPass = (g: Gates): boolean => GATES.every((k) => g[k] === true);

/** somme des 5 critères ; toute valeur != 1 compte 0 (robuste aux trous). */
function computeScore(c: Candidate): number {
  const crit = c.criteria ?? {};
  let s = 0;
  for (const k of CRITERIA) if (crit[k]?.value === 1) s += 1;
  return s;
}

const tierFor = (score: number): number | null =>
  score >= 4 ? 1 : score === KEEP_THRESHOLD ? 2 : null;

/** Évalue un candidat. Ne mute pas l'entrée. */
export function evaluate(c: Candidate): Scored {
  const gates = deriveGates(c);
  if (!gatesPass(gates)) {
    return {
      ...c,
      gates,
      score: null,
      tier: null,
      status: "dropped_gate",
      drop_reason: GATES.filter((k) => gates[k] !== true),
    };
  }
  const score = computeScore(c);
  const tier = tierFor(score);
  return { ...c, gates, score, tier, status: tier === null ? "dropped_score" : "kept" };
}

export function run(cands: Candidate[], keepOnly = false): Scored[] {
  const res = cands.map(evaluate);
  return keepOnly ? res.filter((c) => c.status === "kept") : res;
}

// --------------------------------------------------------------------------- //
function selfTest(): number {
  const ok: Gates = { zone_ok: true, stade_ok: true, produit_ok: true };
  const mk = (g: Gates, vals: number[]): Candidate => ({
    name: "t",
    gates: g,
    criteria: Object.fromEntries(CRITERIA.map((k, i) => [k, { value: vals[i] }])),
  });
  const cases: [Gates, number[], number | null, number | null, string][] = [
    [ok, [1, 1, 1, 1, 1], 5, 1, "kept"],
    [ok, [1, 1, 1, 1, 0], 4, 1, "kept"],
    [ok, [1, 1, 1, 0, 0], 3, 2, "kept"],
    [ok, [1, 1, 0, 0, 0], 2, null, "dropped_score"],
    [ok, [0, 0, 0, 0, 0], 0, null, "dropped_score"],
    [{ zone_ok: false, stade_ok: true, produit_ok: true }, [1, 1, 1, 1, 1], null, null, "dropped_gate"],
    [{ zone_ok: true, stade_ok: true }, [1, 1, 1, 1, 1], null, null, "dropped_gate"], // gate manquante
  ];
  let fails = 0;
  cases.forEach(([g, vals, es, et, est], i) => {
    const r = evaluate(mk(g, vals));
    if (r.score !== es || r.tier !== et || r.status !== est) {
      fails++;
      console.error(`  FAIL #${i}: got (${r.score},${r.tier},${r.status}) expected (${es},${et},${est})`);
    }
  });
  // mapping findall : output.is_matched -> gates ; critères absents -> 0 ; stade absent -> drop gate
  const r2 = evaluate({
    name: "x",
    output: { zone_check: { is_matched: true }, software_product_check: { is_matched: true } },
  });
  if (r2.status !== "dropped_gate" || !r2.drop_reason?.includes("stade_ok")) {
    fails++;
    console.error("  FAIL findall-map:", r2.status, r2.drop_reason);
  }
  console.error("self-test:", fails === 0 ? "OK" : `${fails} ÉCHEC(S)`);
  return fails ? 1 : 0;
}

// --- CLI ------------------------------------------------------------------- //
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (has("--self-test")) {
  process.exit(selfTest());
}

const inPath = flag("--in");
const raw = inPath ? await readFile(inPath, "utf8") : await readStdin();
const data = JSON.parse(raw);
const cands: Candidate[] = Array.isArray(data) ? data : (data.candidates ?? []);
const res = run(cands, has("--keep-only"));
const text = JSON.stringify(res, null, 2);
const outPath = flag("--out");
if (outPath) {
  await writeFile(outPath, text, "utf8");
  const kept = res.filter((c) => c.status === "kept").length;
  console.error(`OK -> ${outPath} | ${res.length} évalués, ${kept} gardés`);
} else {
  console.log(text);
}
