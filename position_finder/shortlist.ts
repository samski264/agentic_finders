/**
 * shortlist.ts — SORTIE + DÉDUP des offres gardées. Zéro API, zéro token.
 *
 * Un seul fichier `shortlist.csv` EST la shortlist + la mémoire de dédup :
 * une offre déjà présente (par URL OU titre+boîte) n'est jamais réécrite.
 *
 * Entrée : sortie de score.ts (scored.json ; on ne garde que status=kept).
 * Action : ajoute les nouvelles offres gardées à shortlist.csv (trié par
 * compatibilité) et imprime un rapport court (nb + top 5).
 *
 * Usage :
 *   node shortlist.ts                       # lit scored.json -> shortlist.csv
 *   node shortlist.ts [--in scored.json] [--csv shortlist.csv] [--json] [--dry-run]
 *   node score.ts --keep-only --out /dev/stdout | node shortlist.ts --stdin
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

type Scored = {
  id?: string;
  title?: string;
  company?: string;
  location?: string;
  country?: string;
  url?: string | null;
  seniority?: string;
  workplace_type?: string;
  nb_employees?: number | null;
  posted_days_ago?: number | null;
  compatibility?: number | null;
  verdict?: string | null;
  reason?: string;
  pros?: string[];
  cons?: string[];
  tier?: number | null;
  status?: string;
  [k: string]: unknown;
};

const FIELDS = [
  "title", "company", "location", "country", "seniority", "workplace_type",
  "nb_employees", "compatibility", "verdict", "tier", "posted_days_ago",
  "reason", "pros", "cons", "url",
] as const;
type Row = Record<(typeof FIELDS)[number], string>;

const normUrl = (u?: string | null): string => (u ? u.replace(/\/+$/, "").toLowerCase() : "");
const normKey = (t?: string, c?: string): string =>
  `${(t ?? "").trim().toLowerCase()}|${(c ?? "").trim().toLowerCase()}`;

// --- CSV minimal ----------------------------------------------------------- //
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

function toRow(c: Scored): Row {
  return {
    title: c.title ?? "",
    company: c.company ?? "",
    location: c.location ?? "",
    country: c.country ?? "",
    seniority: c.seniority ?? "",
    workplace_type: c.workplace_type ?? "",
    nb_employees: c.nb_employees == null ? "" : String(c.nb_employees),
    compatibility: String(c.compatibility ?? ""),
    verdict: c.verdict ?? "",
    tier: String(c.tier ?? ""),
    posted_days_ago: c.posted_days_ago == null ? "" : String(c.posted_days_ago),
    reason: c.reason ?? "",
    pros: (c.pros ?? []).join(" · "),
    cons: (c.cons ?? []).join(" · "),
    url: c.url ?? "",
  } as Row;
}

async function loadExisting(path: string): Promise<{ rows: Row[]; keys: Set<string>; urls: Set<string> }> {
  try {
    const parsed = parseCsv(await readFile(path, "utf8"));
    const rows = parsed.map((p) => Object.fromEntries(FIELDS.map((f) => [f, p[f] ?? ""])) as Row);
    return {
      rows,
      keys: new Set(rows.map((r) => normKey(r.title, r.company))),
      urls: new Set(rows.map((r) => normUrl(r.url)).filter(Boolean)),
    };
  } catch {
    return { rows: [], keys: new Set(), urls: new Set() };
  }
}

function report(neu: Row[]): void {
  console.log(`\n=== Nouvelles offres gardées : ${neu.length} ===`);
  [...neu]
    .sort((a, b) => Number(b.compatibility || 0) - Number(a.compatibility || 0))
    .slice(0, 5)
    .forEach((r) =>
      console.log(`  • [${r.compatibility}/100 t${r.tier} ${r.verdict}] ${r.title} — ${r.company} (${r.location})\n      ${r.reason}`),
    );
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

const inPath = flag("--in") ?? resolve(HERE, "scored.json");
const csvPath = flag("--csv") ?? resolve(HERE, "shortlist.csv");
const jsonPath = has("--json") ? (flag("--json") ?? csvPath.replace(/\.csv$/i, ".json")) : undefined;
const dryRun = has("--dry-run");

const data = JSON.parse(has("--stdin") ? await readStdin() : await readFile(inPath, "utf8"));
const cands: Scored[] = Array.isArray(data) ? data : (data.positions ?? data.candidates ?? []);

const { rows, keys, urls } = await loadExisting(csvPath);
const neu: Row[] = [];
for (const c of cands) {
  if (c.status !== "kept") continue;
  const kk = normKey(c.title, c.company), uk = normUrl(c.url);
  if (keys.has(kk) || (uk && urls.has(uk))) continue;
  neu.push(toRow(c));
  keys.add(kk);
  if (uk) urls.add(uk);
}

if (dryRun) {
  for (const r of neu) console.error(`  [dry-run] + ${r.title} — ${r.company} (compat ${r.compatibility}, tier ${r.tier})`);
  console.error(`OK [dry-run] — ${neu.length} nouvelle(s), 0 écrite(s).`);
  report(neu);
} else {
  const all = [...rows, ...neu].sort(
    (a, b) => Number(b.compatibility || 0) - Number(a.compatibility || 0) || Number(a.tier || 9) - Number(b.tier || 9),
  );
  await writeFile(csvPath, writeCsv(all), "utf8");
  console.error(`OK -> ${csvPath} | +${neu.length} nouvelle(s) | ${all.length} au total.`);
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(all, null, 2), "utf8");
    console.error(`OK -> ${jsonPath} | ${all.length} entrées (JSON).`);
  }
  report(neu);
}
