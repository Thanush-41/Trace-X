import { listCases, getCase } from "@/lib/cases";
import { bundledGroundTruth } from "@/lib/evaluation";
import type { AlertRow } from "@/lib/queries";
import { recordFeedback, runAgent } from "./store";
import { categoryOfDetector, type AgentCategory } from "./trust";

const PRIORITY: AgentCategory[] = ["Cross-system fraud", "Account takeover", "Loan fraud", "Insurance fraud", "Identity fraud", "Shared-device coordination", "Suspicious transfers"];
const KEYS = ["customer_ids", "account_ids", "transaction_ids", "device_ids", "application_ids", "claim_ids"] as const;

/** The category an answer key assigns to a case, or null when the key lists none of its alerts as fraud. */
export function truthCategory(items: { kind: string; detector: string; entities: Partial<Record<(typeof KEYS)[number], string[]>> }[], alerts: AlertRow[]): AgentCategory | null {
  const hit = new Set<AgentCategory>();
  for (const item of items.filter((i) => i.kind === "fraud")) {
    const keys = KEYS.filter((k) => item.entities[k]?.length);
    const matched = alerts.some((a) => a.detector === item.detector && keys.length > 0 && keys.every((k) => (item.entities[k] ?? []).some((id) => (a[k] as string[]).includes(id))));
    if (matched) hit.add(categoryOfDetector(item.detector));
  }
  return PRIORITY.find((c) => hit.has(c)) ?? null;
}

/**
 * Simulated analyst for demos and evaluation: judges each current case against the bundled answer key and records
 * feedback marked source "answer_key_replay". It is real feedback flowing through the real trust model, but it is
 * labelled as simulated everywhere it is shown, and a human's decisions are never mixed up with it.
 */
export async function replayAnswerKey(seeds: number | number[], actor: string, limit = 200) {
  const list = Array.isArray(seeds) ? seeds : [seeds];
  const keys = await Promise.all(list.map((s) => bundledGroundTruth(s)));
  if (keys.some((k) => !k)) throw new Error(`No answer key for seed ${list[keys.findIndex((k) => !k)]}`);
  const truth = { items: keys.flatMap((k) => k!.items) };
  const seed = list.join("+");
  const cases = (await listCases({})).slice(0, limit);
  const results: { case_id: string; predicted: string; truth: string | null; outcome: string; trust_after: number }[] = [];
  for (const c of cases) {
    const data = await getCase(c.case_id);
    if (!data) continue;
    const run = await runAgent(c.case_id, "agent (replay)", { mode: "deterministic" });
    const real = truthCategory(truth.items as never, data.alerts);
    const predicted = run.assessment.predicted_category;
    const outcome = real === null ? "rejected" : real === predicted ? "accepted" : "corrected";
    const fb = await recordFeedback(c.case_id, {
      outcome, corrected_category: outcome === "corrected" ? real! : undefined, assessment_id: run.id,
      reasoning: outcome === "accepted" ? "" : real === null ? `Answer key (seed ${seed}) lists no fraud scenario for this case` : `Answer key (seed ${seed}) lists this case as ${real}`,
    }, actor, "answer_key_replay");
    results.push({ case_id: c.case_id, predicted, truth: real, outcome, trust_after: fb.after.trust });
  }
  return results;
}
