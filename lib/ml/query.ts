import { all } from "@/lib/db/client";
import { latestRun } from "@/lib/queries";
import { MODEL } from "./score";

export type StoredGraphScore = { customer_id: string; score: number; drivers: string[]; neighbours: { customer_id: string; via: string[]; score: number }[] };

/** Graph-model scores from the latest detection run for the given customers (customers below 0.05 are not stored). */
export async function graphScoresFor(customerIds: string[]): Promise<Map<string, StoredGraphScore>> {
  const run = await latestRun();
  if (!run || customerIds.length === 0) return new Map();
  const rows = await all<{ customer_id: string; score: number; drivers_json: string }>(
    `SELECT customer_id, score, drivers_json FROM graph_scores WHERE run_id = ? AND customer_id IN (${customerIds.map(() => "?").join(",")})`, [run.run_id, ...customerIds]);
  return new Map(rows.map((r) => [r.customer_id, { customer_id: r.customer_id, score: Number(r.score), ...JSON.parse(r.drivers_json) }]));
}

export type CaseModelView = { model: string; threshold: number; max: number; flagged: number; customers: StoredGraphScore[]; test: typeof MODEL.test };

export async function caseModelView(customerIds: string[]): Promise<CaseModelView> {
  const m = await graphScoresFor(customerIds);
  const customers = customerIds.map((id) => m.get(id) ?? { customer_id: id, score: 0, drivers: [], neighbours: [] }).sort((a, b) => b.score - a.score);
  return { model: MODEL.name, threshold: MODEL.threshold, max: customers[0]?.score ?? 0, flagged: customers.filter((c) => c.score >= MODEL.threshold).length, customers, test: MODEL.test };
}
