import { all, one } from "@/lib/db/client";
import { buildCaseGraph } from "@/lib/graph";
import { explainGrouping } from "@/lib/consolidation";
import type { Ref } from "@/lib/detect/types";
import { policy } from "@/lib/policy";
import { exposureFor, scoreCase, type CaseScores } from "@/lib/priority";
import { resolveRefs, type AlertRow } from "@/lib/queries";
import { adjustment, AGENT_CATEGORIES, categoryOfDetector, type AgentCategory, type Learned } from "./trust";
import { ACTIONS, isCustomerImpacting } from "@/lib/actions";

/**
 * Evidence-grounded investigation agent. It plans which bounded, read-only tools to call from what the case is
 * missing, runs them, builds one hypothesis per fraud category with supporting and contradicting claims, and then
 * verifies every claim against the stored records before anything is shown. It is a deterministic tool-using
 * planner, not a language model: no free text is generated, so nothing can be invented.
 */
export type Check =
  | { type: "exists"; refs: Ref[] }
  | { type: "field"; ref: Ref; field: string; equals: string | number };
export type Claim = { text: string; stance: "supports" | "contradicts"; weight: number; evidence: Ref[]; check: Check };
export type ToolCall = { tool: string; purpose: string; ok: boolean; summary: string; evidence: Ref[]; result: unknown };
export type Hypothesis = { category: AgentCategory | "Likely legitimate"; confidence: number; supports: Claim[]; contradicts: Claim[] };
export type Assessment = {
  case_id: string; mode: "deterministic-tool-agent"; generated_at: string;
  tool_calls: ToolCall[]; missing_information: { item: string; why: string }[];
  hypotheses: Hypothesis[]; predicted_category: AgentCategory; likely_benign: boolean; confidence: number;
  priority: { tier: string; score: number; reason: string };
  recommended_actions: { action: string; label: string; rationale: string; customer_impacting: boolean; requires_human_approval: boolean; evidence: Ref[] }[];
  verification: { claims_total: number; claims_verified: number; dropped: string[]; grounding: number };
  learning: { signature: string; adjustments: Record<string, number> };
  scores: Pick<CaseScores, "risk" | "confidence" | "exposure">;
};

const k = (r: Ref) => `${r.table}:${r.id}`;

/** Re-reads the cited rows from the database and keeps a claim only if every cited record exists and every stated field matches. */
export async function verifyClaims(claims: Claim[]): Promise<{ verified: Claim[]; dropped: string[] }> {
  const refs = claims.flatMap((c) => (c.check.type === "exists" ? c.check.refs : [c.check.ref]).concat(c.evidence));
  const rows = await resolveRefs(refs);
  const verified: Claim[] = [];
  const dropped: string[] = [];
  for (const c of claims) {
    const cited = c.check.type === "exists" ? c.check.refs : [c.check.ref];
    let ok = c.evidence.length > 0 && c.evidence.every((r) => rows.has(k(r))) && cited.every((r) => rows.has(k(r)));
    if (ok && c.check.type === "field") {
      const v = rows.get(k(c.check.ref))?.[c.check.field];
      ok = typeof c.check.equals === "number" ? Math.abs(Number(v) - c.check.equals) < 0.01 : String(v) === String(c.check.equals);
    }
    if (ok) verified.push(c);
    else dropped.push(c.text);
  }
  return { verified, dropped };
}

export async function investigate(caseRow: { case_id: string; level: string; score: number }, alerts: AlertRow[], learned: Learned): Promise<Assessment> {
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const cross = alerts.find((a) => a.detector === "FD-06");
  const calls: ToolCall[] = [];
  const budget = policy.agent.maxToolCalls;
  const run = async <T,>(tool: string, purpose: string, fn: () => Promise<{ value: T; summary: string; evidence?: Ref[] }>): Promise<T | null> => {
    if (calls.length >= budget) { calls.push({ tool, purpose, ok: false, summary: "Skipped: tool-call budget exhausted", evidence: [], result: null }); return null; }
    try {
      const r = await fn();
      calls.push({ tool, purpose, ok: true, summary: r.summary, evidence: r.evidence ?? [], result: r.value });
      return r.value;
    } catch (e) {
      calls.push({ tool, purpose, ok: false, summary: `Failed: ${(e as Error).message}`, evidence: [], result: null });
      return null;
    }
  };

  // 1. Read the case.
  const records = await run("get_case_records", "Load alerts and the source records they cite", async () => {
    const refs = [...new Map(members.flatMap((a) => [a.primary_ref, ...a.evidence]).map((r) => [k(r), r])).values()];
    const rows = await resolveRefs(refs);
    return { value: { refs, rows, missing: refs.filter((r) => !rows.has(k(r))) }, summary: `${members.length} alerts, ${refs.length} cited records, ${refs.filter((r) => !rows.has(k(r))).length} not found`, evidence: refs.slice(0, 20) };
  });
  const rows = records?.rows ?? new Map<string, Record<string, unknown>>();

  // 2. Exposure.
  const exposure = await run("compute_exposure", "Estimate money at stake", async () => {
    const e = await exposureFor(alerts, rows);
    return { value: e, summary: `₹${e.inr.toLocaleString("en-IN")} across ${e.items.length} record(s)`, evidence: e.items.map((i) => i.ref).slice(0, 20) };
  });

  // 3. Timeline facts.
  const timeline = await run("analyze_timeline", "Find ordering and timing between events", async () => {
    const logins = [...rows.values()].filter((r) => "event_id" in r) as Record<string, unknown>[];
    const failures = logins.filter((l) => l.outcome === "failure").sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const successes = logins.filter((l) => l.outcome === "success" && l.event_type === "login");
    const txns = [...rows.values()].filter((r) => "beneficiary_account" in r) as Record<string, unknown>[];
    const afterLogin = successes.length && txns.length
      ? txns.filter((t) => String(t.timestamp) > String(successes[successes.length - 1].timestamp)).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))[0]
      : undefined;
    const minutes = afterLogin ? Math.round((Date.parse(String(afterLogin.timestamp)) - Date.parse(String(successes[successes.length - 1].timestamp))) / 60000) : null;
    const newCustomers = [...rows.values()].filter((r) => "onboarding_date" in r && "full_name" in r) as Record<string, unknown>[];
    const onboard = newCustomers.map((c) => Date.parse(String(c.onboarding_date))).filter(Number.isFinite).sort((a, b) => a - b);
    const onboardSpanDays = onboard.length >= 2 ? Math.round(((onboard[onboard.length - 1] - onboard[0]) / 86400000) * 10) / 10 : null;
    return {
      value: { failures: failures.length, minutes_login_to_transfer: minutes, onboarding_span_days: onboardSpanDays, onboarded: onboard.length, success_login: successes.length, transfer_after_login: afterLogin ? String(afterLogin.transaction_id) : null },
      summary: `${failures.length} failed login(s); first transfer ${minutes === null ? "n/a" : `${minutes} min`} after the last login; ${onboard.length} customers onboarded${onboardSpanDays === null ? "" : ` within ${onboardSpanDays} days`}`,
      evidence: failures.slice(0, 6).map((f) => ({ table: "login_events" as const, id: String(f.event_id) })),
    };
  });

  // 4. Historical behaviour of the sending customer.
  const flaggedTxn = exposure?.items.find((i) => i.ref.table === "transactions");
  const history = flaggedTxn ? await run("compare_history", "Compare the flagged transfer with the account's earlier behaviour", async () => {
    const row = rows.get(k(flaggedTxn.ref))!;
    const prior = await all<{ transaction_id: string; amount: number }>(
      "SELECT transaction_id, COALESCE(amount_inr, amount) AS amount FROM transactions WHERE account_id = ? AND timestamp < ? AND type != 'deposit' AND status != 'reversed' ORDER BY timestamp DESC LIMIT 100", [row.account_id as string, row.timestamp as string]);
    const amounts = prior.map((p) => Number(p.amount)).sort((a, b) => a - b);
    const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
    const amount = Number(row.amount_inr ?? row.amount);
    return { value: { median, prior: amounts.length, ratio: median ? Math.round((amount / median) * 10) / 10 : null, ref: flaggedTxn.ref },
      summary: amounts.length ? `Flagged ₹${Math.round(amount).toLocaleString("en-IN")} vs median ₹${Math.round(median).toLocaleString("en-IN")} over ${amounts.length} earlier transfer(s)` : "No earlier transfers on this account to compare with",
      evidence: [flaggedTxn.ref, ...prior.slice(0, 5).map((p) => ({ table: "transactions" as const, id: String(p.transaction_id) }))] };
  }) : null;

  // 5. Relationships, when more than one entity is involved.
  const multi = new Set(alerts.flatMap((a) => a.customer_ids)).size > 1 || !!cross || members.length > 2;
  const graph = multi ? await run("inspect_relationships", "Inspect how the entities in the case connect", async () => {
    const g = await buildCaseGraph(alerts);
    const sharedDevices = g.nodes.filter((n) => n.type === "device" && g.edges.filter((e) => e.target === n.id && e.type !== "OWNS").map((e) => e.source).length >= 2);
    const payouts = g.nodes.filter((n) => (n.type === "account" || n.type === "external_account") && g.edges.filter((e) => e.target === n.id && ["PAYOUT_TO", "DISBURSEMENT", "TRANSFER"].includes(e.type)).length >= 2);
    const bridges = g.nodes.filter((n) => n.bridge);
    return { value: { nodes: g.nodes.length, edges: g.edges.length, sharedDevices: sharedDevices.map((n) => n.label), payouts: payouts.map((n) => n.label), bridges: bridges.map((n) => n.label), edgeEvidence: g.edges.flatMap((e) => e.evidence.slice(0, 1)).slice(0, 10) },
      summary: `${g.nodes.length} entities, ${g.edges.length} links; ${sharedDevices.length} shared device(s), ${payouts.length} multi-source account(s), ${bridges.length} bridge entity(ies)`,
      evidence: g.edges.flatMap((e) => e.evidence.slice(0, 1)).slice(0, 10) };
  }) : null;
  if (multi) await run("explain_grouping", "Check why these alerts were consolidated", async () => {
    const x = await explainGrouping(alerts);
    return { value: { shared: x.shared.length, weak: x.per_alert.filter((p) => p.weakly_connected).map((p) => p.alert_id) }, summary: `${x.shared.length} shared entities; ${x.per_alert.filter((p) => p.weakly_connected).length} weakly connected alert(s)`, evidence: x.shared.flatMap((s) => s.refs).slice(0, 10) };
  });

  // 6. Missing information, which can trigger one more lookup.
  const missing: Assessment["missing_information"] = [];
  const miss = await run("check_missing_information", "Find fields and context that are absent", async () => {
    for (const r of rows.values()) {
      if ("event_id" in r && !r.ip_address) missing.push({ item: `IP address missing on login ${r.event_id}`, why: "cannot compare network location" });
      if ("application_id" in r && !r.device_id) missing.push({ item: `Device missing on application ${r.application_id}`, why: "cannot tie the application to a device" });
      if ("claim_id" in r && !r.document_hash) missing.push({ item: `Invoice fingerprint missing on claim ${r.claim_id}`, why: "cannot test for a reused document" });
      if ("full_name" in r && !r.phone_norm) missing.push({ item: `Phone missing for customer ${r.customer_id}`, why: "cannot test for shared contact details" });
    }
    if (history && history.prior < 5) missing.push({ item: `Only ${history.prior} earlier transfer(s) on the sending account`, why: "behavioural baseline is thin" });
    if (members.length === 1) missing.push({ item: "No second detector corroborates this alert", why: "single-source evidence" });
    return { value: missing.length, summary: `${missing.length} gap(s) found`, evidence: [] };
  });
  void miss;
  if (missing.length && calls.length < budget) {
    await run("lookup_customer_history", "Look up prior alerts for the primary customer to fill gaps", async () => {
      const cust = alerts.flatMap((a) => a.customer_ids)[0];
      const prior = cust ? await one<{ n: number }>("SELECT COUNT(DISTINCT a.alert_id) AS n FROM alerts a, json_each(a.customer_ids) j WHERE j.value = ? AND a.level != 'Low'", [cust]) : undefined;
      return { value: { customer: cust, prior_actionable_alerts: Number(prior?.n ?? 0) }, summary: `${cust ?? "no customer"} has ${Number(prior?.n ?? 0)} actionable alert(s) on record`, evidence: cust ? [{ table: "customers", id: cust }] : [] };
    });
  }

  // Hypotheses, one per category, from stored signals and mitigations plus tool facts.
  const scores = await scoreCase(caseRow, alerts, rows);
  const byCat = new Map<AgentCategory, Claim[]>();
  const push = (cat: AgentCategory, c: Claim) => byCat.set(cat, [...(byCat.get(cat) ?? []), c]);
  for (const a of alerts) {
    const cat = categoryOfDetector(a.detector);
    if (a.detector === "FD-06") {
      for (const s of a.signals.filter((x) => x.weight > 0 || x.code === "BRIDGING_ENTITIES")) {
        push(cat, { text: `${s.label}: ${s.detail}`, stance: "supports", weight: Math.min(3, Math.max(1, s.weight / 10)), evidence: s.evidence.slice(0, 6), check: { type: "exists", refs: s.evidence.slice(0, 6) } });
      }
      continue;
    }
    push(cat, { text: `${a.detector} raised "${a.title}" at ${a.level} risk (${a.score}/100)`, stance: "supports", weight: Math.min(3, a.score / 30), evidence: [a.primary_ref], check: { type: "exists", refs: [a.primary_ref] } });
    for (const s of a.signals.filter((x) => x.weight > 0 && x.evidence.length)) {
      push(cat, { text: `${s.label}: ${s.detail}`, stance: "supports", weight: Math.min(2, s.weight / 15), evidence: s.evidence.slice(0, 6), check: { type: "exists", refs: s.evidence.slice(0, 6) } });
    }
    for (const m of a.mitigations.filter((x) => x.evidence.length)) {
      push(cat, { text: `${m.label}: ${m.detail}`, stance: "contradicts", weight: Math.min(2, m.weight / 15), evidence: m.evidence.slice(0, 6), check: { type: "exists", refs: m.evidence.slice(0, 6) } });
    }
  }
  if (cross) {
    const detectors = new Set(members.map((a) => a.detector));
    const customers = new Set(members.flatMap((a) => a.customer_ids));
    const refs = members.map((a) => a.primary_ref).slice(0, 8);
    push("Cross-system fraud", { text: `${members.length} alerts from ${detectors.size} detectors across ${customers.size} customer(s) are linked through shared entities`, stance: "supports", weight: 15 * Math.max(1, new Set(members.map((a) => categoryOfDetector(a.detector))).size - 1), evidence: refs, check: { type: "exists", refs } });
  }
  if (timeline?.failures && timeline.failures >= 3) {
    const refs = (calls.find((c) => c.tool === "analyze_timeline")?.evidence ?? []).slice(0, 5);
    if (refs.length) push("Account takeover", { text: `${timeline.failures} failed logins occurred before a successful one`, stance: "supports", weight: 2, evidence: refs, check: { type: "exists", refs } });
  }
  if (history?.ratio && history.ratio >= 3) {
    const row = rows.get(k(history.ref))!;
    push(categoryOfDetector(members.find((a) => a.transaction_ids.includes(history.ref.id))?.detector ?? "FD-01"), {
      text: `The flagged transfer is ${history.ratio}× the account's median of ₹${Math.round(history.median).toLocaleString("en-IN")}`, stance: "supports", weight: 1.5, evidence: [history.ref],
      check: { type: "field", ref: history.ref, field: "account_id", equals: String(row.account_id) } });
  }
  if (graph?.bridges?.length && cross) {
    const refs = (calls.find((c) => c.tool === "inspect_relationships")?.evidence ?? []).slice(0, 4);
    if (refs.length) push("Cross-system fraud", { text: `Bridge entities link different systems: ${graph.bridges.slice(0, 4).join(", ")}`, stance: "supports", weight: 2, evidence: refs, check: { type: "exists", refs } });
  }

  // Verify, drop what fails, then score.
  const all_claims = [...byCat.values()].flat();
  const { verified, dropped } = await verifyClaims(all_claims);
  const ok = new Set(verified);
  const signature = [...new Set(members.map((a) => a.detector))].sort().join("+") || "none";
  const adjustments: Record<string, number> = {};
  const hypotheses: Hypothesis[] = [];
  const raw = new Map<AgentCategory, number>();
  for (const [cat, claims] of byCat) {
    const supports = claims.filter((c) => c.stance === "supports" && ok.has(c));
    const contradicts = claims.filter((c) => c.stance === "contradicts" && ok.has(c));
    if (!supports.length) continue;
    const sup = supports.reduce((s, c) => s + c.weight, 0);
    const con = contradicts.reduce((s, c) => s + c.weight, 0);
    const adj = adjustment(learned, signature, cat);
    adjustments[cat] = Math.round(adj * 100) / 100;
    // Diminishing returns: ten weak signals must not outvote one decisive structural link.
    raw.set(cat, Math.log2(1 + Math.max(0, sup - 0.5 * con)) * adj);
    hypotheses.push({ category: cat, confidence: 0, supports, contradicts });
  }
  const total = [...raw.values()].reduce((s, v) => s + v, 0) || 1;
  for (const h of hypotheses) h.confidence = Math.round(((raw.get(h.category as AgentCategory) ?? 0) / total) * 100) / 100;
  hypotheses.sort((a, b) => b.confidence - a.confidence);
  const lead = hypotheses[0];
  const signalPoints = members.flatMap((a) => a.signals).reduce((s, x) => s + Math.max(0, x.weight), 0);
  const mitigationPoints = members.flatMap((a) => a.mitigations).reduce((s, x) => s + x.weight, 0);
  const likelyBenign = signalPoints > 0 && mitigationPoints >= signalPoints * 0.6;
  const predicted = (lead?.category ?? "Suspicious transfers") as AgentCategory;
  const confidence = Math.round((lead?.confidence ?? 0) * (0.5 + 0.5 * scores.confidence.score) * 100) / 100;
  if (likelyBenign) {
    const refs = members.flatMap((a) => a.mitigations.flatMap((m) => m.evidence)).slice(0, 6);
    hypotheses.push({ category: "Likely legitimate", confidence: Math.round(Math.min(0.95, mitigationPoints / (signalPoints + mitigationPoints)) * 100) / 100, supports: refs.length ? [{ text: `Legitimate context offsets ${mitigationPoints} of ${signalPoints} signal points`, stance: "supports", weight: 2, evidence: refs, check: { type: "exists", refs } }] : [], contradicts: [] });
  }

  const gaps = missing.length;
  const rec: Assessment["recommended_actions"] = [];
  const addRec = (action: keyof typeof ACTIONS, rationale: string, evidence: Ref[] = []) => rec.push({ action, label: ACTIONS[action].label, rationale, customer_impacting: isCustomerImpacting(action), requires_human_approval: true, evidence });
  const leadRefs = lead?.supports.flatMap((c) => c.evidence).slice(0, 4) ?? [];
  if (scores.priority.needs_more_evidence || gaps >= 2) addRec("REQUEST_INFORMATION", `Evidence confidence is ${Math.round(scores.confidence.score * 100)}% with ${gaps} gap(s): ${missing.slice(0, 2).map((m) => m.item).join("; ") || "single-source evidence"}`);
  if (likelyBenign) addRec("FALSE_POSITIVE", "Legitimate context outweighs the signals; confirm with the customer before closing", leadRefs);
  else addRec("REQUIRES_INVESTIGATION", `${predicted} hypothesis leads at ${Math.round((lead?.confidence ?? 0) * 100)}% evidence share`, leadRefs);
  if (!likelyBenign && (cross || scores.priority.tier === "Critical")) addRec("ESCALATE_SUPERVISOR", cross ? "Cross-system coordination across several customers" : "Critical priority tier", leadRefs);
  if (!likelyBenign && predicted === "Account takeover") addRec("RECOMMEND_ENHANCED_VERIFICATION", "Customer should confirm the new device and recent changes; recommendation only, a supervisor must approve", leadRefs);
  if (!likelyBenign && scores.exposure.inr > 0 && scores.priority.tier !== "Needs More Evidence" && scores.risk.level === "High") addRec("RECOMMEND_HOLD", `₹${scores.exposure.inr.toLocaleString("en-IN")} exposure at High risk; recommendation only, a supervisor must approve`, scores.exposure.items.map((i) => i.ref).slice(0, 4));

  return {
    case_id: caseRow.case_id, mode: "deterministic-tool-agent", generated_at: new Date().toISOString(), tool_calls: calls, missing_information: missing,
    hypotheses, predicted_category: predicted, likely_benign: likelyBenign, confidence,
    priority: { tier: scores.priority.tier, score: scores.priority.score, reason: scores.priority.reason },
    recommended_actions: rec,
    verification: { claims_total: all_claims.length, claims_verified: verified.length, dropped, grounding: all_claims.length ? Math.round((verified.length / all_claims.length) * 100) / 100 : 0 },
    learning: { signature, adjustments },
    scores: { risk: scores.risk, confidence: scores.confidence, exposure: scores.exposure },
  };
}
export { AGENT_CATEGORIES };
