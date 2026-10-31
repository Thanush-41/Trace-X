import { all } from "@/lib/db/client";
import { CUSTOMER_IMPACTING } from "@/lib/actions";
import { AUTONOMOUS_ALLOWLIST, loadFeedback, trustReport } from "./store";
import type { Assessment } from "./investigate";

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Level 2 evaluation computed from stored feedback, assessments and logs. Nothing here is typed in. */
export async function agentEvaluation() {
  const [feedback, trust] = await Promise.all([loadFeedback(), trustReport()]);
  const assessments = await all<{ id: number; confidence: number; assessment_json: string }>("SELECT id, confidence, assessment_json FROM agent_assessments");
  const byId = new Map(assessments.map((a) => [Number(a.id), a]));
  const n = feedback.length;
  const accepted = feedback.filter((f) => f.outcome === "accepted").length;
  const human = feedback.filter((f) => f.source === "analyst");
  const sim = feedback.filter((f) => f.source !== "analyst");

  const bins = [[0, 0.5], [0.5, 0.8], [0.8, 1.01]] as const;
  const calibration = bins.map(([lo, hi]) => {
    const rows = feedback.filter((f) => { const c = Number(byId.get(Number(f.assessment_id))?.confidence ?? -1); return c >= lo && c < hi; });
    const hit = rows.filter((f) => f.outcome === "accepted").length;
    return { range: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: rows.length, accuracy: pct(hit, rows.length) };
  });

  const rejected = feedback.filter((f) => f.outcome === "rejected");
  const benignFlagged = rejected.filter((f) => {
    const a = byId.get(Number(f.assessment_id));
    return a && (JSON.parse(a.assessment_json) as Assessment).likely_benign;
  }).length;

  const caseCount = Number((await all<{ n: number }>("SELECT COUNT(*) AS n FROM cases"))[0]?.n ?? 0);
  const splitCount = Number((await all<{ n: number }>("SELECT COUNT(*) AS n FROM case_splits"))[0]?.n ?? 0);
  const agentActs = await all<{ action: string }>("SELECT action FROM agent_actions");
  const violations = agentActs.filter((a) => !AUTONOMOUS_ALLOWLIST.includes(a.action) || (CUSTOMER_IMPACTING as readonly string[]).includes(a.action)).length;
  const impacting = Number((await all<{ n: number }>(`SELECT COUNT(*) AS n FROM case_actions WHERE actor LIKE 'TRACE X agent%' AND action IN (${CUSTOMER_IMPACTING.map(() => "?").join(",")})`, [...CUSTOMER_IMPACTING]))[0]?.n ?? 0);

  const holdN = trust.reduce((s, c) => s + c.holdout.n, 0);
  const holdAcc = trust.reduce((s, c) => s + (c.holdout.accuracy ?? 0) * c.holdout.n, 0);
  return {
    feedback: { total: n, analyst: human.length, simulated_replay: sim.length },
    agent_correctness: { accepted, corrected: feedback.filter((f) => f.outcome === "corrected").length, rejected: rejected.length, accuracy: pct(accepted, n) },
    override_rate: { analyst_only: pct(human.filter((f) => f.outcome !== "accepted").length, human.length), all: pct(n - accepted, n) },
    calibration,
    false_positive_handling: { cases_judged_not_fraud: rejected.length, agent_flagged_as_likely_legitimate: benignFlagged, share: pct(benignFlagged, rejected.length) },
    grouping_quality: { cases: caseCount, analyst_splits: splitCount, split_rate: pct(splitCount, caseCount) },
    holdout: { n: holdN, accuracy: holdN ? Math.round((holdAcc / holdN) * 1000) / 10 : null },
    autonomous_safety: { autonomous_actions: agentActs.length, allowlist: [...AUTONOMOUS_ALLOWLIST], allowlist_violations: violations, customer_impacting_actions_by_agent: impacting },
    categories: trust.map((c) => ({ category: c.category, n: c.n, trust: c.trust, level: c.level_name, holdout_n: c.holdout.n, holdout_accuracy: c.holdout.accuracy })),
  };
}
