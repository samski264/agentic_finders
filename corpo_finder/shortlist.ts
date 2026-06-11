/**
 * shortlist.ts — SORTIE + DÉDUP (étapes 2 et 6 du pipe). Zéro API, zéro token.
 *
 * Un seul fichier `shortlist.csv` EST la shortlist + la mémoire de dédup :
 * une boîte déjà présente (par Nom OU Site) n'est jamais réécrite.
 *
 * Entrée : sortie de score.ts (candidats status=kept).
 * Action : ajoute les nouvelles boîtes gardées à shortlist.csv (trié par score
 * puis tier) et imprime un rapport court (nb + top 3).
 *
 * dedupKey aligné sur index.ts (url normalisée, sinon name).
 *
 * Usage :
 *   node score.ts --in enrichis.json --keep-only | node shortlist.ts
 *   node shortlist.ts --in scored.json [--csv shortlist.csv] [--dry-run]
 */
import { readFile, writeFile } from "node:fs/promises";

type Crit = { value?: number; why?: string; source?: string };
type Candidate = {
  name: string;
  url?: string | null;
  city?: string;
  source?: string;
  score?: number | null;
  tier?: number | null;
  status?: string;
  criteria?: Record<string, Crit>;
  [k: string]: unknown;
};

const FIELDS = [
  "name", "url", "city", "score", "tier", "source",
  "produit_pertinent", "culture_builder", "stack_match",
  "decideur_joignable", "signal_frais", "signal_why",
] as const;
const CRIT = ["produit_pertinent", "culture_builder", "stack_match", "decideur_joignable", "signal_frais"] as const;

type Row = Record<(typeof FIELDS)[number], string>;

const normUrl = (u?: string | null): string =>
  u ? u.replace(/\/+$/, "").toLowerCase() : "";
const normName = (n?: string): string => (n ?? "").trim().toLowerCase();

// --- CSV minimal (lecture + écriture, gère guillemets/virgules/retours) ---- //
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function writeCsv(rows: Row[]): string {
  const head = FIELDS.join(",");
  const body = rows.map((r) => FIELDS.map((f) => csvCell(r[f] ?? "")).join(",")).join("\n");
  return rows.length ? `${head}\n${body}\n` : `${head}\n`;
}
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((c) => c !== "")) rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Objet structuré (typé) à partir d'une ligne CSV : pratique à consommer par un programme. */
function rowToObject(r: Row) {
  const num = (v: string): number | null => (v === "" || v == null ? null : Number(v));
  const bit = (v: string): 0 | 1 => (r[v as keyof Row] === "1" ? 1 : 0);
  return {
    name: r.name,
    url: r.url || null,
    city: r.city || null,
    score: num(r.score),
    tier: num(r.tier),
    source: r.source || null,
    criteria: {
      produit_pertinent: bit("produit_pertinent"),
      culture_builder: bit("culture_builder"),
      stack_match: bit("stack_match"),
      decideur_joignable: bit("decideur_joignable"),
      signal_frais: bit("signal_frais"),
    },
    signal_why: r.signal_why || null,
  };
}

function toRow(c: Candidate): Row {
  const crit = c.criteria ?? {};
  const val = (k: string) => String(crit[k]?.value ?? 0);
  const sf = crit["signal_frais"] ?? {};
  return {
    name: c.name ?? "",
    url: c.url ?? "",
    city: c.city ?? "",
    score: String(c.score ?? ""),
    tier: String(c.tier ?? ""),
    source: c.source ?? "",
    produit_pertinent: val("produit_pertinent"),
    culture_builder: val("culture_builder"),
    stack_match: val("stack_match"),
    decideur_joignable: val("decideur_joignable"),
    signal_frais: val("signal_frais"),
    signal_why: sf.why ?? "",
  } as Row;
}

async function loadExisting(path: string): Promise<{ rows: Row[]; names: Set<string>; urls: Set<string> }> {
  try {
    const parsed = parseCsv(await readFile(path, "utf8"));
    const rows = parsed.map((p) => Object.fromEntries(FIELDS.map((f) => [f, p[f] ?? ""])) as Row);
    return {
      rows,
      names: new Set(rows.map((r) => normName(r.name))),
      urls: new Set(rows.map((r) => normUrl(r.url)).filter(Boolean)),
    };
  } catch {
    return { rows: [], names: new Set(), urls: new Set() };
  }
}

function report(neu: Row[]): void {
  console.log(`\n=== Nouvelles boîtes gardées : ${neu.length} ===`);
  [...neu]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 3)
    .forEach((r) => console.log(`  • ${r.name} — score ${r.score}/5 (tier ${r.tier}) — ${r.url}`));
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

const inPath = flag("--in");
const csvPath = flag("--csv") ?? "shortlist.csv";
const jsonPath = has("--json") ? (flag("--json") ?? csvPath.replace(/\.csv$/i, ".json")) : undefined;
const dryRun = has("--dry-run");

const data = JSON.parse(inPath ? await readFile(inPath, "utf8") : await readStdin());
const cands: Candidate[] = Array.isArray(data) ? data : (data.candidates ?? []);

const { rows, names, urls } = await loadExisting(csvPath);
const neu: Row[] = [];
for (const c of cands) {
  if (c.status !== "kept") continue;
  const nk = normName(c.name), uk = normUrl(c.url);
  if ((nk && names.has(nk)) || (uk && urls.has(uk))) continue;
  neu.push(toRow(c));
  names.add(nk);
  if (uk) urls.add(uk);
}

if (dryRun) {
  for (const r of neu) console.error(`  [dry-run] + ${r.name} (score ${r.score}, tier ${r.tier})`);
  console.error(`OK [dry-run] — ${neu.length} nouvelle(s), 0 écrite(s).`);
  report(neu);
} else {
  const all = [...rows, ...neu].sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.tier || 9) - Number(b.tier || 9),
  );
  await writeFile(csvPath, writeCsv(all), "utf8");
  console.error(`OK -> ${csvPath} | +${neu.length} nouvelle(s) | ${all.length} au total.`);
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(all.map(rowToObject), null, 2), "utf8");
    console.error(`OK -> ${jsonPath} | ${all.length} entr\u00e9es (JSON structur\u00e9).`);
  }
  report(neu);
}
