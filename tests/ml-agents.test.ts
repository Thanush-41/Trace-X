import { beforeAll, describe, expect, it, vi } from "vitest";

// The language model is mocked: the test checks what the code does with whatever the model says.
const replies: Record<string, unknown>[] = [];
vi.mock("@/lib/agent/llm", () => ({
  llmEnabled: () => replies.length > 0,
  llmModel: () => "mock-model",
  chatJson: async () => ({ json: replies.shift() ?? {}, ms: 5, tokens: 10, model: "mock-model" }),
}));

import { all, resetWorkspace } from "@/lib/db/client";
import { loadSample } from "@/lib/ingest/samples";
import { detect, runDetection } from "@/lib/detect/run";
import { loadContext } from "@/lib/detect/context";
import { scoreTransfers } from "@/lib/detect/anomaly";
import { getCase, listCases } from "@/lib/cases";
import { checkSql, runAgentSql, ROW_LIMIT } from "@/lib/agent/sql-guard";
import { scoreCustomers, MODEL } from "@/lib/ml/score";
import { customerLabels } from "@/lib/ml/labels";
import { metrics } from "@/lib/ml/mlp";
import { bundledGroundTruth } from "@/lib/evaluation";
import { runAgent, recordFeedback } from "@/lib/agent/store";
import { splitFor } from "@/lib/agent/trust";
import { validateRow } from "@/lib/ingest/validate";

describe("SQL agent guard", () => {
  it.each([
    "DELETE FROM customers", "SELECT 1; DROP TABLE customers", "UPDATE accounts SET status='x'", "PRAGMA table_info(customers)",
    "SELECT * FROM agent_feedback", "SELECT * FROM case_decisions", "SELECT * FROM sqlite_master", "SELECT * FROM alerts", "WITH x AS (SELECT 1) INSERT INTO customers SELECT * FROM x",
  ])("rejects %s", (q) => expect(checkSql(q).ok).toBe(false));
  it("accepts reads over source tables, CTEs and json_each", () => {
    for (const q of ["SELECT customer_id FROM customers WHERE city = 'Pune'", "WITH t AS (SELECT * FROM transactions) SELECT COUNT(*) FROM t JOIN accounts a ON a.account_id = t.account_id", "SELECT score FROM graph_scores;"]) expect(checkSql(q).ok).toBe(true);
  });
  it("caps rows and strips provenance columns", async () => {
    await resetWorkspace(); await loadSample(1);
    const r = await runAgentSql("SELECT * FROM transactions");
    expect(r.ok).toBe(true);
    expect(r.row_count).toBe(ROW_LIMIT);
    expect(Object.keys(r.rows[0])).not.toContain("row_hash");
  });
});

describe("enriched data fields", () => {
  it("validates session telemetry and payee-name check without rejecting the row", () => {
    const login = validateRow("login_events", { event_id: "L1", customer_id: "C1", timestamp: "2026-10-01T10:00:00Z", outcome: "success", sim_swap_days: "2", remote_access: "yes", emulator_or_rooted: "maybe", typing_anomaly: "1.7" });
    expect(login.record?.sim_swap_days).toBe(2);
    expect(login.record?.remote_access).toBe(1);
    expect(login.record?.emulator_or_rooted).toBeNull();
    expect(login.record?.typing_anomaly).toBeNull();
    expect(login.warnings.length).toBeGreaterThanOrEqual(2);
    const txn = validateRow("transactions", { transaction_id: "T1", account_id: "A1", beneficiary_account: "B1", amount: "100", timestamp: "2026-10-01T10:00:00Z", payee_name_check: "Mismatch" });
    expect(txn.record?.payee_name_check).toBe("no_match");
  });
  it("takeover findings use telemetry and transfers use the payee check", async () => {
    await resetWorkspace(); await loadSample(3);
    const { findings } = await detect();
    const codes = new Set(findings.flatMap((f) => f.signals.map((s) => s.code)));
    expect(codes.has("PAYEE_NAME_MISMATCH")).toBe(true);
    expect(["SIM_SWAP_RECENT", "REMOTE_ACCESS_TOOL", "DEVICE_TAMPERING", "BEHAVIOUR_MISMATCH"].some((c) => codes.has(c))).toBe(true);
  });
});

describe("graph neural network", () => {
  it("ranks fraud-linked customers well on a sealed seed it never saw", async () => {
    await resetWorkspace(); await loadSample(202);
    const ctx = await loadContext();
    ctx.anomaly = scoreTransfers(ctx);
    const scores = scoreCustomers(ctx);
    const labels = customerLabels(ctx, (await bundledGroundTruth(202))!);
    const ids = [...labels.keys()];
    const m = metrics(ids.map((id) => scores.get(id)!.score), ids.map((id) => labels.get(id)!));
    expect(m.auc!).toBeGreaterThan(0.9);
    expect(m.ap!).toBeGreaterThan(0.6);
    const top = [...scores.values()].sort((a, b) => b.score - a.score)[0];
    expect(top.drivers.length).toBeGreaterThan(0);
  });
  it("detection stores graph scores and model-only findings stay Low", async () => {
    await resetWorkspace(); await loadSample(1);
    const run = await runDetection();
    expect(Number((await all<{ n: number }>("SELECT COUNT(*) AS n FROM graph_scores WHERE run_id = ?", [run.run_id]))[0].n)).toBeGreaterThan(0);
    const gnn = await all<{ level: string }>("SELECT level FROM alerts WHERE detector = 'FD-GNN'");
    expect(gnn.every((a) => a.level === "Low")).toBe(true);
    expect(MODEL.threshold).toBeGreaterThan(0);
  });
});

describe("multi-agent investigation", () => {
  let caseId: string;
  beforeAll(async () => {
    await resetWorkspace(); await loadSample(1); await runDetection();
    const all_ = await listCases({});
    caseId = (await Promise.all(all_.map((c) => getCase(c.case_id)))).find((d) => d!.alerts.some((a) => a.detector === "FD-03"))!.case.case_id;
  });

  it("verifies every citation in code, drops fabricated IDs and downgrades unsupported verdicts", async () => {
    const data = (await getCase(caseId))!;
    const victim = data.alerts.find((a) => a.detector === "FD-03")!.customer_ids[0];
    replies.push(
      { brief: "Takeover suspected", focus_entities: [victim], open_questions: [], hypothesis_budget: 2 },
      { hypotheses: [{ category: "Account takeover", statement: "Account was taken over", supporting_ids: [victim], would_confirm: "failed logins", would_refute: "known device" }, { category: "Loan fraud", statement: "Invented loan ring", supporting_ids: ["APP99999999"], would_confirm: "", would_refute: "" }] },
      { queries: [{ hypothesis: 0, purpose: "failed logins", sql: `SELECT event_id, customer_id, outcome FROM login_events WHERE customer_id = '${victim}'` }, { hypothesis: 1, purpose: "bad", sql: "DELETE FROM loan_applications" }] },
      { queries: [{ hypothesis: 1, purpose: "fixed", sql: "SELECT application_id FROM loan_applications WHERE application_id = 'APP99999999'" }] },
      { hypotheses: [{ index: 0, verdict: "supported", confidence: 0.9, cited_ids: [victim, "LGN0000000000"], rationale: "failures then success" }, { index: 1, verdict: "supported", confidence: 0.8, cited_ids: ["APP99999999"], rationale: "made up" }],
        predicted_category: "Account takeover", likely_benign: false, overall_confidence: 0.8, reviewer_score: 0.7, reviewer_notes: "", recommended_actions: [{ action: "RECOMMEND_HOLD", rationale: "exposure" }, { action: "TRANSFER_FUNDS", rationale: "not allowed" }], missing_information: [] },
    );
    const r = await runAgent(caseId, "Asha");
    const a = r.assessment;
    expect(a.mode).toBe("llm-multi-agent");
    expect(a.agents!.map((s) => s.agent)).toEqual(["orchestrator", "hypothesis", "sql", "sql", "reviewer"]);
    expect(a.sql!.find((s) => s.purpose === "bad" || s.purpose === "fixed")!.ok).toBe(true);
    expect(a.sql!.some((s) => s.repaired)).toBe(true);
    expect(a.verification.claims_total).toBe(3);
    expect(a.verification.claims_verified).toBe(1);
    expect(a.verification.dropped.some((d) => d.includes("APP99999999"))).toBe(true);
    const loan = a.hypotheses.find((h) => h.category === "Loan fraud")!;
    expect(loan.confidence).toBeLessThanOrEqual(0.4);
    expect(a.predicted_category).toBe("Account takeover");
    expect(a.recommended_actions.map((x) => x.action)).toEqual(["RECOMMEND_HOLD"]);
    expect(a.recommended_actions[0].requires_human_approval).toBe(true);
    expect(await all("SELECT 1 FROM loan_applications WHERE application_id = 'APP99999999'")).toHaveLength(0);
  });

  it("falls back to the deterministic agent when the model fails", async () => {
    replies.push({ not: "what the orchestrator expects" });
    const r = await runAgent(caseId, "Asha");
    expect(["llm-multi-agent", "deterministic-tool-agent"]).toContain(r.assessment.mode);
  });

  it("feedback on a training case writes a lesson that is retrieved next time; held-out cases teach nothing", async () => {
    const cases = await listCases({});
    const train = cases.find((c) => splitFor(c.case_id) === "train")!;
    const hold = cases.find((c) => splitFor(c.case_id) === "holdout");
    const run = await runAgent(train.case_id, "Asha", { mode: "deterministic" });
    const other = run.assessment.predicted_category === "Account takeover" ? "Loan fraud" : "Account takeover";
    replies.push({ lesson: "When failed logins precede a new-device login and a payee is added, takeover is more likely than a forgotten password." });
    const fb = await recordFeedback(train.case_id, { outcome: "corrected", corrected_category: other, reasoning: "victim confirmed they did not log in" }, "Asha");
    replies.length = 0;
    expect(fb.lesson).toMatch(/takeover/);
    const lessons = await all<{ lesson: string; source: string }>("SELECT lesson, source FROM agent_lessons");
    expect(lessons.some((l) => l.source === "llm")).toBe(true);
    if (hold) {
      const before = lessons.length;
      await runAgent(hold.case_id, "Asha", { mode: "deterministic" });
      await recordFeedback(hold.case_id, { outcome: "rejected", reasoning: "customer confirmed it" }, "Asha");
      expect((await all("SELECT 1 FROM agent_lessons")).length).toBe(before);
    }
  });
});
