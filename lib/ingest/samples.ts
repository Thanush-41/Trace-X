import fs from "node:fs/promises";
import path from "node:path";
import { LOAD_ORDER } from "./fields";
import { ingestFile, type IngestFailure, type IngestResult } from "./load";

const SAMPLES_DIR = path.join(process.cwd(), "data", "samples");

export type SampleSet = { seed: number; name: string; files: string[] };

export async function listSamples(): Promise<SampleSet[]> {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true }).catch(() => []);
  const sets: SampleSet[] = [];
  for (const e of entries) {
    const m = e.isDirectory() && e.name.match(/^seed-(\d+)$/);
    if (!m) continue;
    const files = (await fs.readdir(path.join(SAMPLES_DIR, e.name))).filter((f) => f !== "ground_truth.json" && !f.startsWith(".") && !f.startsWith("~")).sort();
    sets.push({ seed: Number(m[1]), name: e.name, files });
  }
  return sets.sort((a, b) => a.seed - b.seed);
}

/** Loads the five core CSV files of a bundled sample through the normal ingestion pipeline. */
export async function loadSample(seed: number): Promise<(IngestResult | IngestFailure)[]> {
  const dir = path.join(SAMPLES_DIR, `seed-${seed}`);
  const results: (IngestResult | IngestFailure)[] = [];
  for (const type of LOAD_ORDER) {
    const file = `${type}.csv`;
    const buffer = await fs.readFile(path.join(dir, file));
    results.push(...(await ingestFile(buffer, `seed-${seed}/${file}`, type)));
  }
  return results;
}

/** Serves a bundled sample file (for download links on the Ingest screen). */
export async function readSampleFile(seed: number, file: string): Promise<Buffer | null> {
  if (!/^[a-z_]+\.(csv|xlsx|json)$/.test(file)) return null;
  return fs.readFile(path.join(SAMPLES_DIR, `seed-${seed}`, file)).catch(() => null);
}
