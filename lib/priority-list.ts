import { all } from "@/lib/db/client";
import { listCases, type CaseRow } from "@/lib/cases";
import { parseAlert, resolveRefs, type AlertRow } from "@/lib/queries";
import { scoreCase, type CaseScores } from "@/lib/priority";

export type RankedCase = CaseRow & { scores: CaseScores };

/** Cases with their separate scores, most urgent first. Loads alerts and records once for the whole list. */
export async function rankedCases(filters: Parameters<typeof listCases>[0] = { status: "open" }, limit?: number): Promise<RankedCase[]> {
  const cases = await listCases(filters);
  if (!cases.length) return [];
  const rows = await all<Record<string, unknown>>(
    `SELECT ca.case_id AS _case, a.* FROM case_alerts_effective ca JOIN alerts a ON a.alert_id = ca.alert_id WHERE ca.case_id IN (${cases.map(() => "?").join(",")})`, cases.map((c) => c.case_id));
  const byCase = new Map<string, AlertRow[]>();
  for (const r of rows) byCase.set(String(r._case), [...(byCase.get(String(r._case)) ?? []), parseAlert(r)]);
  const refs = [...byCase.values()].flat().filter((a) => a.detector !== "FD-06").flatMap((a) => [a.primary_ref, ...a.evidence,
    ...a.transaction_ids.map((id) => ({ table: "transactions" as const, id })), ...a.application_ids.map((id) => ({ table: "loan_applications" as const, id })), ...a.claim_ids.map((id) => ({ table: "insurance_claims" as const, id }))]);
  const records = await resolveRefs(refs);
  const ranked: RankedCase[] = [];
  for (const c of cases) ranked.push({ ...c, scores: await scoreCase(c, byCase.get(c.case_id) ?? [], records) });
  ranked.sort((a, b) => b.scores.priority.score - a.scores.priority.score || b.scores.exposure.inr - a.scores.exposure.inr);
  return limit ? ranked.slice(0, limit) : ranked;
}
