import { readFile, writeFile } from "node:fs/promises";
import Parallel from "parallel-web";

const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });

const RESULTS_FILE = "results.json";
const ADDITIONAL_MATCH_LIMIT = 50;

const OBJECTIVE =
  "FindAll software companies in Switzerland, France or the Benelux (Belgium, Netherlands, Luxembourg) where product, design and engineering are tightly coupled and a generalist product engineer ships end-to-end. Strong fit: teams building web apps, AI products (LLM, embeddings, semantic search), 3D / WebGL / real-time / spatial / VR experiences, creative or design tooling, no-code/visual builders, or developer tooling, on a modern TypeScript stack (Next.js, React, Three.js, Node). Include early-stage and growth-stage startups across all funding stages, prioritizing small teams where one person owns a feature from interface to infrastructure.";

const MATCH_CONDITIONS = [
  {
    name: "zone_check",
    description:
      "Company headquarters or a main office is in Switzerland, France, Belgium, the Netherlands or Luxembourg, or the company is remote-first within the EU.",
  },
  {
    name: "software_product_check",
    description:
      "Company's core offering is a software product or platform (web app, AI product, 3D/WebGL/real-time, creative or design tooling, or developer tooling). Exclude pure consulting and service firms, marketing/creative agencies, and hardware-only companies with no software product.",
  },
];

type Candidate = {
  name: string;
  url: string | null;
  description: string | null;
  output: unknown;
  basis: unknown;
};

type Store = {
  findall_id: string;
  status: string;
  generated_at: string;
  metrics: unknown;
  matched_count: number;
  candidates: Candidate[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dedupKey = (c: { name: string; url?: string | null }) =>
  c.url ? c.url.replace(/\/+$/, "").toLowerCase() : `name:${c.name.toLowerCase()}`;

async function loadStore(): Promise<Store | null> {
  try {
    return JSON.parse(await readFile(RESULTS_FILE, "utf8")) as Store;
  } catch {
    return null;
  }
}

async function waitUntilDone(findallId: string) {
  while (true) {
    const current = await client.beta.findall.retrieve(findallId);
    const { generated_candidates_count = 0, matched_candidates_count = 0 } =
      current.status.metrics;
    console.log(
      `[${current.status.status}] generated: ${generated_candidates_count} | matched: ${matched_candidates_count}`,
    );
    if (!current.status.is_active) return current.status;
    await sleep(5000);
  }
}

const existing = await loadStore();

let findallId: string;

if (existing?.findall_id) {
  findallId = existing.findall_id;
  console.log(
    `Extending existing run ${findallId} (+${ADDITIONAL_MATCH_LIMIT} matches)`,
  );
  await client.beta.findall.extend(findallId, {
    additional_match_limit: ADDITIONAL_MATCH_LIMIT,
  });
} else {
  const run = await client.beta.findall.create({
    objective: OBJECTIVE,
    entity_type: "companies",
    match_conditions: MATCH_CONDITIONS,
    generator: "base",
    match_limit: ADDITIONAL_MATCH_LIMIT,
  });
  findallId = run.findall_id;
  console.log(`Run started: ${findallId}`);
}

const status = await waitUntilDone(findallId);

const result = await client.beta.findall.result(findallId);
const matched: Candidate[] = result.candidates
  .filter((c) => c.match_status === "matched")
  .map((c) => ({
    name: c.name,
    url: c.url ?? null,
    description: c.description ?? null,
    output: c.output ?? null,
    basis: c.basis ?? null,
  }));

const merged = new Map<string, Candidate>();
for (const c of existing?.candidates ?? []) merged.set(dedupKey(c), c);
const before = merged.size;
for (const c of matched) merged.set(dedupKey(c), c);
const candidates = [...merged.values()];
const added = candidates.length - before;

const store: Store = {
  findall_id: findallId,
  status: status.status,
  generated_at: new Date().toISOString(),
  metrics: status.metrics,
  matched_count: candidates.length,
  candidates,
};

await writeFile(RESULTS_FILE, JSON.stringify(store, null, 2), "utf8");

console.log(
  `\nDone (${status.status}). +${added} new companies, ${candidates.length} total in ${RESULTS_FILE}.`,
);
