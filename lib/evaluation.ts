import fs from "node:fs/promises";
import path from "node:path";
import { all } from "@/lib/db/client";
import { evaluate, groundTruthSchema, type EvalAlert, type GroundTruth } from "@/lib/detect/evaluate";
import { latestRun, parseAlert } from "@/lib/queries";

/** Bundled answer key for a sample seed. Read only here, never by detection. */
export async function bundledGroundTruth(seed: number): Promise<GroundTruth | null> {
  const file = path.join(process.cwd(), "data", "samples", `seed-${seed}`, "ground_truth.json");
  const text = await fs.readFile(file, "utf8").catch(() => null);
  return text ? groundTruthSchema.parse(JSON.parse(text)) : null;
}

/** Scores the latest detection run's stored alerts against a ground-truth file. */
export async function evaluateLatestRun(truth: GroundTruth) {
  const run = await latestRun();
  if (!run) return null;
  const rows = await all<Record<string, unknown>>("SELECT a.* FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ?", [run.run_id]);
  const alerts: EvalAlert[] = rows.map(parseAlert).map((a) => ({
    alert_id: a.alert_id, detector: a.detector, level: a.level, score: a.score, title: a.title,
    entities: { customer_ids: a.customer_ids, account_ids: a.account_ids, transaction_ids: a.transaction_ids, device_ids: a.device_ids, application_ids: a.application_ids, claim_ids: a.claim_ids },
    signals: a.signals.map(({ label, weight }) => ({ label, weight })),
    mitigations: a.mitigations.map(({ label, weight }) => ({ label, weight })),
  }));
  const counts = JSON.parse(run.counts_json) as { ms: number; records: Record<string, number> };
  return { run_id: run.run_id, policy_version: run.policy_version, ms: counts.ms, records: counts.records, seed: truth.seed ?? null, ...evaluate(truth, alerts) };
}
