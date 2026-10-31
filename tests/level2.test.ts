import { beforeAll, describe, expect, it } from "vitest";
import { all, getDb, resetWorkspace } from "@/lib/db/client";
import { loadSample } from "@/lib/ingest/samples";
import { runDetection } from "@/lib/detect/run";
import { getCase, listCases } from "@/lib/cases";
import { DetectionContext } from "@/lib/detect/context";
import { correlate, sourceKeys } from "@/lib/detect/fd06-cross-system";
import { emptyEntities, type ScoredFinding } from "@/lib/detect/types";
import { buildCaseGraph } from "@/lib/graph";
import { explainGrouping, splitCase } from "@/lib/consolidation";
import { ACTIONS, decideApproval, isCustomerImpacting, listActions, performAction } from "@/lib/actions";
import { exposureFor, scoreCase } from "@/lib/priority";
import { buildReport, reportPdf } from "@/lib/report";
import { investigate, verifyClaims } from "@/lib/agent/investigate";
import { assertAgentMayPerform, getSettings, recordFeedback, runAgent, setKillSwitch, setThresholds, trustReport } from "@/lib/agent/store";
import { computeTrust, levelFor, learnFrom, type FeedbackRow } from "@/lib/agent/trust";
import { resolveRefs, type AlertRow } from "@/lib/queries";
import { policy } from "@/lib/policy";
import { agentEvaluation } from "@/lib/agent/evaluation";

const finding = (id: string, over: Omit<Partial<ScoredFinding>, "entities"> & { entities?: Partial<ReturnType<typeof emptyEntities>> }): ScoredFinding => ({
  detector: "FD-01", category: "x", title: id, subject_type: "customer", subject_id: id, primary_ref: { table: "customers", id }, event_time: "2026-10-01T00:00:00Z",
  signals: [], mitigations: [], evidence: [], products: new Set(["banking"]), raw_score: 80, score: 80, level: "High", floor_note: null, fingerprint: `fp-${id}`, alert_id: `ALT-${id}`,
  ...over, entities: { ...emptyEntities(), ...(over.entities ?? {}) },
}) as ScoredFinding;

describe("L2.1 cross-system correlation through every entity type", () => {
  const ctx = new DetectionContext();
  ctx.customers.set("C1", { customer_id: "C1", phone_norm: "999" } as never);
  ctx.customers.set("C2", { customer_id: "C2", phone_norm: "999" } as never);
  ctx.phoneDegree.set("999", 2);
  ctx.loginById.set("L1", { event_id: "L1", ip_address: "1.2.3.4" } as never);
  ctx.loginById.set("L2", { event_id: "L2", ip_address: "1.2.3.4" } as never);
  ctx.ipDegree.set("1.2.3.4", 2);
  ctx.claimById.set("K1", { claim_id: "K1", policy_id: "P1", document_hash: "H" } as never);
  ctx.claimById.set("K2", { claim_id: "K2", policy_id: "P1", document_hash: "H" } as never);
  const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
  const pair = (kind: string, a: Partial<ScoredFinding> & { entities?: object }, b: Partial<ScoredFinding> & { entities?: object }) => {
    const groups = correlate(ctx, [finding(`${kind}a`, a as never), finding(`${kind}b`, b as never)]);
    return groups.length;
  };
  it.each([
    ["customer", { entities: { customers: new Set(["Z"]) } }, { entities: { customers: new Set(["Z"]) } }],
    ["account / beneficiary", { entities: { accounts: new Set(["ACC9"]) } }, { entities: { accounts: new Set(["ACC9"]) } }],
    ["device", { entities: { devices: new Set(["DEV1"]) } }, { entities: { devices: new Set(["DEV1"]) } }],
    ["loan application", { entities: { applications: new Set(["APP1"]) } }, { entities: { applications: new Set(["APP1"]) } }],
    ["transaction", { entities: { transactions: new Set(["T1"]) } }, { entities: { transactions: new Set(["T1"]) } }],
    ["claim", { entities: { claims: new Set(["K1"]) } }, { entities: { claims: new Set(["K1"]) } }],
    ["phone number", { entities: { customers: new Set(["C1"]) } }, { entities: { customers: new Set(["C2"]) } }],
    ["IP address", { evidence: [{ table: "login_events", id: "L1" }] }, { evidence: [{ table: "login_events", id: "L2" }] }],
    ["insurance policy", { entities: { claims: new Set(["K1"]) } }, { entities: { claims: new Set(["K2"]) } }],
  ] as const)("links alerts sharing a %s", (kind, a, b) => {
    expect(pair(kind, a as never, b as never)).toBe(1);
  });
  it("sourceKeys name the matching source field for phone, IP, policy and document", () => {
    const keys = sourceKeys(ctx, finding("x", { entities: { customers: new Set(["C1"]), claims: new Set(["K1"]) }, evidence: [{ table: "login_events", id: "L1" }] }));
    expect(keys).toEqual(expect.arrayContaining(["phone:999", "ip:1.2.3.4", "pol:P1", "doc:H"]));
  });
  it("time-aware: a shared phone outside the window does not join alerts; unrelated alerts stay apart", () => {
    const far = correlate(ctx, [finding("a", { entities: { customers: new Set(["C1"]) }, event_time: at(1) }), finding("b", { entities: { customers: new Set(["C2"]) }, event_time: `2027-03-01T00:00:00Z` })]);
    expect(far).toHaveLength(2);
    expect(correlate(ctx, [finding("a", { entities: { customers: new Set(["Q"]) } }), finding("b", { entities: { customers: new Set(["R"]) } })])).toHaveLength(2);
  });
  it("hubs are attenuated: a phone shared by more customers than the hub limit links nothing", () => {
    ctx.phoneDegree.set("999", policy.hubDegree + 1);
    expect(correlate(ctx, [finding("a", { entities: { customers: new Set(["C1"]) } }), finding("b", { entities: { customers: new Set(["C2"]) } })])).toHaveLength(2);
    ctx.phoneDegree.set("999", 2);
  });
});

describe("Level 2 case workflow", () => {
  let crossCase: string;
  let ringAlerts: AlertRow[];
  beforeAll(async () => {
    await resetWorkspace();
    await loadSample(1);
    await runDetection();
    const cases = await listCases({});
    crossCase = (await Promise.all(cases.map((c) => getCase(c.case_id)))).find((d) => d!.alerts.some((a) => a.detector === "FD-06") && d!.alerts.length >= 6)!.case.case_id;
    ringAlerts = (await getCase(crossCase))!.alerts;
  });

  it("L2.2 every graph edge resolves to source records and nothing is invented", async () => {
    const g = await buildCaseGraph(ringAlerts);
    expect(g.edges.length).toBeGreaterThan(10);
    const types = new Set(g.nodes.map((n) => n.type));
    for (const t of ["customer", "account", "external_account", "device", "loan_application", "claim", "policy"]) expect(types.has(t as never)).toBe(true);
    const nodeIds = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.why).toBeTruthy();
      expect(nodeIds.has(e.source) && nodeIds.has(e.target)).toBe(true);
      const rows = await resolveRefs(e.evidence);
      for (const r of e.evidence) expect(rows.has(`${r.table}:${r.id}`)).toBe(true);
    }
    expect(g.edges.some((e) => e.suspicious)).toBe(true);
    expect(g.nodes.some((n) => n.bridge)).toBe(true);
  });

  it("L2.3 consolidation explains why alerts were grouped: shared entity, source field, time", async () => {
    const x = await explainGrouping(ringAlerts);
    expect(x.shared.length).toBeGreaterThan(0);
    expect(x.shared.every((s) => s.field && s.alerts.length >= 2)).toBe(true);
    expect(x.shared.some((s) => s.kind === "dev" || s.kind === "acct")).toBe(true);
    expect(x.summary).toMatch(/grouped because/);
  });

  it("L2.3 analyst split moves alerts with a reason, preserves originals, and survives a re-run", async () => {
    const before = await all("SELECT * FROM alerts ORDER BY alert_id");
    const members = ringAlerts.filter((a) => a.detector === "FD-03");
    await expect(splitCase(crossCase, { alert_ids: members.map((a) => a.alert_id), reason: "short" }, "Asha")).rejects.toThrow();
    const res = await splitCase(crossCase, { alert_ids: members.map((a) => a.alert_id), reason: "Account takeover victim is unrelated to the loan ring" }, "Asha (asha)");
    expect(await all("SELECT * FROM alerts ORDER BY alert_id")).toEqual(before);
    const kept = (await getCase(crossCase))!;
    const moved = (await getCase(res.to_case_id))!;
    expect(moved.alerts.map((a) => a.alert_id).sort()).toEqual(members.map((a) => a.alert_id).sort());
    expect(kept.alerts.some((a) => a.detector === "FD-03")).toBe(false);
    expect(kept.alerts.some((a) => a.detector === "FD-06")).toBe(false);
    expect((await listActions(res.to_case_id)).some((a) => a.action === "SPLIT_CASE" && a.reason?.includes("unrelated"))).toBe(true);

    const run = await runDetection();
    expect(run.new_alerts).toBeGreaterThanOrEqual(0);
    const after = (await getCase(res.to_case_id))!;
    expect(after.alerts.filter((a) => a.detector !== "FD-06").map((a) => a.alert_id).sort()).toEqual(members.map((a) => a.alert_id).sort());
    const again = (await getCase(crossCase))!;
    expect(again.alerts.some((a) => a.detector === "FD-03")).toBe(false);
    const owners = await all<{ alert_id: string; n: number }>("SELECT alert_id, COUNT(*) AS n FROM case_alerts_effective WHERE alert_id IN (SELECT alert_id FROM alerts WHERE detector='FD-03') GROUP BY alert_id");
    expect(owners.every((o) => Number(o.n) === 1)).toBe(true);
    await expect(splitCase(crossCase, { alert_ids: again.alerts.filter((a) => a.detector !== "FD-06").map((a) => a.alert_id), reason: "Moving everything is not a split" }, "Asha")).rejects.toThrow(/at least one/);
  });

  it("L2.4 every action is recorded with actor and time; history is immutable", async () => {
    const [c] = await listCases({ level: "High" });
    for (const action of Object.keys(ACTIONS)) {
      const saved = await performAction(c.case_id, { action, reason: "Documented reason for this step", outcome: action === "SET_CONCLUSION" ? "confirmed_fraud" : undefined }, "Asha (asha)");
      expect(saved.id).toBeGreaterThan(0);
    }
    const list = await listActions(c.case_id);
    expect(list.length).toBeGreaterThanOrEqual(Object.keys(ACTIONS).length);
    expect(list.every((a) => a.actor && a.created_at)).toBe(true);
    expect((await getCase(c.case_id))!.case.status).toBe("CLOSED");
    await expect((await getDb()).execute("UPDATE case_actions SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect((await getDb()).execute("DELETE FROM case_actions")).rejects.toThrow(/append-only/);
    await expect(performAction(c.case_id, { action: "FALSE_POSITIVE", reason: "" }, "Asha")).rejects.toThrow(/reason/);
  });

  it("L2.4/L2.B customer-impacting recommendations need an authorised, different approver and are never executed", async () => {
    const [c] = await listCases({ level: "High" });
    const rec = await performAction(c.case_id, { action: "RECOMMEND_HOLD", reason: "Funds likely to leave today" }, "Asha (asha)");
    expect(rec.status).toBe("pending_approval");
    expect(isCustomerImpacting("RECOMMEND_HOLD")).toBe(true);
    await expect(decideApproval(c.case_id, rec.id, "approved", "Looks right to me", "Ravi", "analyst")).rejects.toThrow(/supervisor/);
    await expect(decideApproval(c.case_id, rec.id, "approved", "Looks right to me", "Asha (asha)", "admin")).rejects.toThrow(/person who raised/);
    await decideApproval(c.case_id, rec.id, "approved", "Supervisor confirmed the exposure", "Sam (sam)", "admin");
    await expect(decideApproval(c.case_id, rec.id, "rejected", "Changed my mind", "Sam (sam)", "admin")).rejects.toThrow(/already been decided/);
    const view = (await listActions(c.case_id)).find((a) => a.id === rec.id)!;
    expect(view.effective_status).toBe("approved");
    expect(await all("SELECT 1 FROM agent_actions WHERE action IN ('RECOMMEND_HOLD','RECOMMEND_ENHANCED_VERIFICATION')")).toHaveLength(0);
  });

  it("L2.6 exposure, confidence, risk and priority are separate; low evidence is not escalated", async () => {
    const data = (await getCase(crossCase))!;
    const s = await scoreCase(data.case, data.alerts, data.rows);
    expect(s.exposure.inr).toBeGreaterThan(0);
    expect(Object.keys(s)).toEqual(expect.arrayContaining(["risk", "confidence", "exposure", "priority"]));
    const ex = await exposureFor(data.alerts, data.rows);
    expect(new Set(ex.items.map((i) => `${i.ref.table}:${i.ref.id}`)).size).toBe(ex.items.length);

    const weak = { alert_id: "ALT-w", detector: "FD-01", level: "High", score: 80, signals: [{ code: "AMOUNT_OUTLIER", label: "x", weight: 40, detail: "", evidence: [{ table: "transactions", id: "none" }] }], mitigations: [], evidence: [{ table: "transactions", id: "none" }], primary_ref: { table: "transactions", id: "none" }, customer_ids: ["CUSX"], products: ["banking"], transaction_ids: [], application_ids: [], claim_ids: [], account_ids: [], device_ids: [] } as unknown as AlertRow;
    const low = await scoreCase({ level: "High", score: 80 }, [weak]);
    expect(low.priority.needs_more_evidence).toBe(true);
    expect(low.priority.tier).toBe("Needs More Evidence");
    expect(low.priority.score).toBeLessThanOrEqual(59);
    expect(s.priority.tier).not.toBe("Needs More Evidence");
  });

  it("L2.5 case report: structured JSON and PDF with every reference resolved", async () => {
    const r = await buildReport(crossCase, "Asha");
    expect(r.audit.unresolved_references).toBe(0);
    expect(r.evidence_index.every((e) => e.exists)).toBe(true);
    expect(r.graph.edges.length).toBeGreaterThan(0);
    expect(r.timeline.length).toBeGreaterThan(0);
    expect(r.scores.note).toMatch(/separate/);
    expect(r.integrity.sha256).toHaveLength(64);
    const pdf = reportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain(crossCase);
    expect(pdf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("B.7 agent output is structured and every displayed claim is verified against records", async () => {
    const [c] = await listCases({ level: "High" });
    const data = (await getCase(c.case_id))!;
    const a = await investigate(data.case, data.alerts, learnFrom([]));
    expect(a.tool_calls.length).toBeGreaterThanOrEqual(4);
    expect(a.tool_calls.length).toBeLessThanOrEqual(policy.agent.maxToolCalls);
    expect(a.hypotheses.length).toBeGreaterThan(0);
    expect(a.verification.claims_verified).toBeGreaterThan(0);
    for (const h of a.hypotheses) for (const claim of [...h.supports, ...h.contradicts]) {
      expect(claim.evidence.length).toBeGreaterThan(0);
      const rows = await resolveRefs(claim.evidence);
      for (const r of claim.evidence) expect(rows.has(`${r.table}:${r.id}`)).toBe(true);
    }
    for (const r of a.recommended_actions.filter((x) => x.customer_impacting)) expect(r.requires_human_approval).toBe(true);
    const bad = await verifyClaims([{ text: "fabricated", stance: "supports", weight: 1, evidence: [{ table: "transactions", id: "TXN-DOES-NOT-EXIST" }], check: { type: "exists", refs: [{ table: "transactions", id: "TXN-DOES-NOT-EXIST" }] } }]);
    expect(bad.verified).toHaveLength(0);
    expect(bad.dropped).toEqual(["fabricated"]);
  });
});

describe("Agent trust and autonomy", () => {
  const row = (id: number, cat: string, outcome: FeedbackRow["outcome"], split: FeedbackRow["split"] = "train"): FeedbackRow => ({
    id, case_id: `CASE-${id}`, predicted_category: cat, outcome, corrected_category: outcome === "corrected" ? "Loan fraud" : null, grounding: 1, source: "analyst", split, signature: "FD-03", created_at: `2026-10-${String(1 + (id % 28)).padStart(2, "0")}`, actor: "a",
  });
  const trustOf = (rows: FeedbackRow[], cat: string) => computeTrust(rows).find((c) => c.category === cat)!;

  it("starts at zero trust and L0 in every category", () => {
    for (const c of computeTrust([])) { expect(c.trust).toBe(0); expect(c.level).toBe(0); expect(c.n).toBe(0); }
  });
  it("B.8 correct feedback raises trust; incorrect feedback lowers it", () => {
    const good = Array.from({ length: 6 }, (_, i) => row(i + 1, "Account takeover", "accepted"));
    const t1 = trustOf(good, "Account takeover").trust;
    const t0 = trustOf(good.slice(0, 3), "Account takeover").trust;
    expect(t1).toBeGreaterThan(t0);
    const worse = trustOf([...good, row(7, "Account takeover", "corrected")], "Account takeover");
    expect(worse.trust).toBeLessThan(t1);
    expect(worse.trend.at(-1)!.delta).toBeLessThan(0);
    expect(worse.last_change).toMatch(/fell/);
    expect(trustOf([...good, row(8, "Account takeover", "rejected")], "Account takeover").trust).toBeLessThan(t1);
  });
  it("uses a conservative bound and stays low with little data", () => {
    const one = trustOf([row(1, "Loan fraud", "accepted")], "Loan fraud");
    expect(one.trust).toBeLessThan(0.1);
    expect(one.lower_bound).toBeLessThan(one.n ? 0.5 : 1);
    const many = trustOf(Array.from({ length: 30 }, (_, i) => row(i + 1, "Loan fraud", "accepted")), "Loan fraud");
    expect(many.trust).toBeGreaterThan(0.8);
    expect(many.trust).toBeLessThan(1);
  });
  it("feedback in one category does not give another category trust or autonomy", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, "Account takeover", "accepted", i % 4 === 0 ? "holdout" : "train"));
    const all = computeTrust(rows);
    expect(all.find((c) => c.category === "Account takeover")!.level).toBe(3);
    for (const c of all.filter((c) => c.category !== "Account takeover")) { expect(c.trust).toBe(0); expect(c.level).toBe(0); }
  });
  it("L3 needs volume, trust and held-out accuracy together", () => {
    const t = policy.agent.levels;
    expect(levelFor(500, 0.99, 0, 0).level).toBe(2);
    expect(levelFor(t.L3.minFeedback, 0.99, t.L3.minHoldout, 0.5).level).toBe(2);
    expect(levelFor(t.L3.minFeedback - 1, 0.99, 10, 1).level).toBe(2);
    expect(levelFor(t.L3.minFeedback, 0.99, t.L3.minHoldout, 1).level).toBe(3);
    expect(levelFor(0, 0, 0, 0).level).toBe(0);
  });
  it("repeating or replaying a review of the same case does not add trust; the latest human verdict counts", () => {
    const base = Array.from({ length: 5 }, (_, i) => row(i + 1, "Account takeover", "accepted"));
    const repeated = [...base, ...Array.from({ length: 10 }, (_, i) => ({ ...row(100 + i, "Account takeover", "accepted"), case_id: "CASE-1" }))];
    expect(trustOf(repeated, "Account takeover").trust).toBe(trustOf(base, "Account takeover").trust);
    expect(trustOf(repeated, "Account takeover").n).toBe(5);
    const flipped = [...base, { ...row(200, "Account takeover", "rejected"), case_id: "CASE-1" }];
    expect(trustOf(flipped, "Account takeover").rejected).toBe(1);
    const replayAfterHuman = [...flipped, { ...row(300, "Account takeover", "accepted"), case_id: "CASE-1", source: "answer_key_replay" }];
    expect(trustOf(replayAfterHuman, "Account takeover").rejected).toBe(1);
  });

    it("held-out feedback is never learned from and never moves trust", () => {
    const base = Array.from({ length: 5 }, (_, i) => row(i + 1, "Account takeover", "accepted"));
    const withHold = [...base, row(6, "Account takeover", "rejected", "holdout")];
    expect(trustOf(withHold, "Account takeover").trust).toBe(trustOf(base, "Account takeover").trust);
    expect(trustOf(withHold, "Account takeover").holdout.n).toBe(1);
    expect(Object.keys(learnFrom([row(1, "Account takeover", "corrected", "holdout")]).reject)).toHaveLength(0);
  });

  describe("with real cases", () => {
    let transferCase: string;
    beforeAll(async () => {
      await resetWorkspace();
      await loadSample(2);
      await runDetection();
      transferCase = (await Promise.all((await listCases({})).map((c) => getCase(c.case_id)))).find((d) => d!.alerts.length === 1 && d!.alerts[0].detector === "FD-01")!.case.case_id;
    });

    it("feedback must attach to an assessment and capture accepted / corrected / rejected with evidence", async () => {
      await expect(recordFeedback(transferCase, { outcome: "accepted" }, "Asha")).rejects.toThrow(/Run the agent/);
      const a = await runAgent(transferCase, "Asha");
      await expect(recordFeedback(transferCase, { outcome: "corrected", corrected_category: a.assessment.predicted_category, reasoning: "same thing" }, "Asha")).rejects.toThrow(/accept it instead/);
      await expect(recordFeedback(transferCase, { outcome: "rejected" }, "Asha")).rejects.toThrow(/Explain/);
      await expect(recordFeedback(transferCase, { outcome: "corrected", corrected_category: "Loan fraud", reasoning: "x", evidence: ["transactions:NOPE"] }, "Asha")).rejects.toThrow();
      const ok = await recordFeedback(transferCase, { outcome: "accepted" }, "Asha");
      expect(ok.after.n).toBe(ok.before.n + (ok.split === "train" ? 1 : 0));
      expect(ok.loop).toMatch(/Assessment #\d+ → accepted/);
      await expect((await getDb()).execute("UPDATE agent_feedback SET outcome = 'rejected'")).rejects.toThrow(/append-only/);
    });

    it("a wrong recommendation lowers a category's trust in the real database", async () => {
      const { splitFor } = await import("@/lib/agent/trust");
      const db = await getDb();
      const cases = await listCases({});
      let picked: { id: string; assessment: number; category: string } | null = null;
      for (const c of cases) {
        if (splitFor(c.case_id) !== "train") continue;
        const a = await runAgent(c.case_id, "Asha");
        picked = { id: c.case_id, assessment: a.id, category: a.assessment.predicted_category };
        break;
      }
      expect(picked).not.toBeNull();
      for (let i = 0; i < 10; i++) {
        await db.execute({ sql: "INSERT INTO agent_feedback (assessment_id, case_id, predicted_category, outcome, grounding, source, split, signature, actor, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", args: [picked!.assessment, `CASE-pre-${i}`, picked!.category, "accepted", 1, "analyst", "train", "x", "hist", `2026-09-${10 + i}T00:00:00Z`] });
      }
      const before = (await trustReport()).find((x) => x.category === picked!.category)!;
      expect(before.trust).toBeGreaterThan(0);
      const res = await recordFeedback(picked!.id, { outcome: "rejected", assessment_id: picked!.assessment, reasoning: "Customer confirmed the activity" }, "Asha");
      expect(res.after.trust).toBeLessThan(before.trust);
      const after = (await trustReport()).find((x) => x.category === picked!.category)!;
      expect(after.trend.at(-1)!.delta).toBeLessThan(0);
      expect(after.last_change).toMatch(/fell/);
    });

    it("agent never performs a customer-impacting action, and safe internal actions need L3 and the kill switch off", async () => {
      for (const action of ["RECOMMEND_HOLD", "BLOCK_TRANSACTION", "RESTRICT_ACCOUNT", "TRANSFER_FUNDS", "ADVERSE_DECISION", "RECOMMEND_ENHANCED_VERIFICATION", "UNKNOWN"]) expect(() => assertAgentMayPerform(action)).toThrow();
      for (const action of ["LABEL_CASE", "ROUTE_TO_QUEUE", "REQUEST_ANALYST_REVIEW"]) expect(() => assertAgentMayPerform(action)).not.toThrow();

      const first = await runAgent(transferCase, "Asha");
      expect(first.autonomous.level).toBeLessThan(3);
      expect(first.autonomous.performed).toEqual([]);

      // History that earns L3 for Suspicious transfers: 24 accepted training decisions and 6 accepted held-out decisions.
      const db = await getDb();
      const rows: [string, string][] = [];
      for (let i = 0; i < 90; i++) rows.push([`CASE-hist-${i}`, ""]);
      let train = 0, hold = 0;
      const { splitFor } = await import("@/lib/agent/trust");
      for (const [cid] of rows) {
        const sp = splitFor(cid);
        if (sp === "train" && train >= 24) continue;
        if (sp === "holdout" && hold >= 6) continue;
        if (sp === "train") train++; else hold++;
        await db.execute({ sql: "INSERT INTO agent_feedback (assessment_id, case_id, predicted_category, outcome, grounding, source, split, signature, actor, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", args: [first.id, cid, first.assessment.predicted_category, "accepted", 1, "analyst", sp, first.assessment.learning.signature, "hist", "2026-10-02T00:00:00Z"] });
      }
      const cat = (await trustReport()).find((c) => c.category === first.assessment.predicted_category)!;
      expect(cat.level).toBe(3);

      const l3 = await runAgent(transferCase, "Asha");
      expect(l3.autonomous.performed.sort()).toEqual(["LABEL_CASE", "REQUEST_ANALYST_REVIEW", "ROUTE_TO_QUEUE"]);
      const logged = await all<{ action: string; reversible: number }>("SELECT action, reversible FROM agent_actions");
      expect(logged.every((l) => ["LABEL_CASE", "ROUTE_TO_QUEUE", "REQUEST_ANALYST_REVIEW"].includes(l.action) && Number(l.reversible) === 1)).toBe(true);
      expect(await all("SELECT 1 FROM case_actions WHERE actor LIKE 'TRACE X agent%' AND action IN ('RECOMMEND_HOLD','RECOMMEND_ENHANCED_VERIFICATION')")).toHaveLength(0);
      expect((await getCase(transferCase))!.case.status).toBe("OPEN");

      await setKillSwitch(true, "admin");
      expect((await getSettings()).kill_switch).toBe(true);
      const killed = await runAgent(transferCase, "Asha");
      expect(killed.autonomous.performed).toEqual([]);
      expect(killed.autonomous.blocked).toMatch(/kill switch/);
      await setKillSwitch(false, "admin");

      const ev = await agentEvaluation();
      expect(ev.autonomous_safety.allowlist_violations).toBe(0);
      expect(ev.autonomous_safety.customer_impacting_actions_by_agent).toBe(0);
      expect(ev.feedback.total).toBeGreaterThan(30);
      await setThresholds({ L3: { minFeedback: 5, minHoldout: 3 } }, "admin");
      await expect(setThresholds({ L3: { minHoldout: 0 } }, "admin")).rejects.toThrow();
    });
  });
});
