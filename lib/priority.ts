import { policy } from "@/lib/policy";
import type { AlertRow } from "@/lib/queries";
import { resolveRefs } from "@/lib/queries";
import type { Ref } from "@/lib/detect/types";

/**
 * Four separate quantities, never merged into one number:
 *  risk       how suspicious the strongest evidence is (detector score)
 *  confidence how complete and corroborated the evidence is
 *  exposure   money at stake in the records the alerts point at
 *  priority   the order investigators should work cases in; combines the above transparently
 * (the agent's trust score is a fourth, separate quantity that lives in lib/agent/trust.ts).
 */
export type ExposureItem = { ref: Ref; amount: number; kind: string; note: string };
export type CaseScores = {
  risk: { score: number; level: string };
  confidence: { score: number; factors: { label: string; value: number; detail: string }[] };
  exposure: { inr: number; items: ExposureItem[] };
  priority: { score: number; tier: "Critical" | "High" | "Medium" | "Low" | "Needs More Evidence"; components: { label: string; value: number; weight: number; detail: string }[]; needs_more_evidence: boolean; reason: string };
  indicators: { ato: boolean; cross_system: boolean; detectors: string[]; products: string[]; customers: number };
};

const TXN_DETECTORS = new Set(["FD-01", "FD-03", "FD-08", "FD-ML"]);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const keyOf = (r: Ref) => `${r.table}:${r.id}`;

/** Money at stake, counting each source record once: flagged outgoing transfers, requested loans and claimed amounts. */
export async function exposureFor(alerts: AlertRow[], rows?: Map<string, Record<string, unknown>>): Promise<CaseScores["exposure"]> {
  const refs: Ref[] = [];
  for (const a of alerts) {
    if (a.detector === "FD-06") continue;
    if (TXN_DETECTORS.has(a.detector)) {
      if (a.primary_ref.table === "transactions") refs.push(a.primary_ref);
      else a.transaction_ids.forEach((id) => refs.push({ table: "transactions", id }));
    }
    if (a.detector === "FD-05") a.application_ids.forEach((id) => refs.push({ table: "loan_applications", id }));
    if (a.detector === "FD-07") a.claim_ids.forEach((id) => refs.push({ table: "insurance_claims", id }));
  }
  const unique = [...new Map(refs.map((r) => [keyOf(r), r])).values()];
  const resolved = rows && unique.every((r) => rows.has(keyOf(r))) ? rows : await resolveRefs(unique);
  const items: ExposureItem[] = [];
  for (const r of unique) {
    const row = resolved.get(keyOf(r));
    if (!row) continue;
    if (r.table === "transactions") {
      if (row.status === "reversed" || row.type === "deposit") continue;
      items.push({ ref: r, amount: Number(row.amount_inr ?? row.amount), kind: "Flagged transfer", note: `${row.account_id} → ${row.beneficiary_account}` });
    } else if (r.table === "loan_applications") {
      if (String(row.status ?? "").toLowerCase() === "rejected") continue;
      items.push({ ref: r, amount: Number(row.requested_amount), kind: "Loan requested", note: `${row.customer_id}, payout ${row.payout_account}` });
    } else if (r.table === "insurance_claims") {
      items.push({ ref: r, amount: Number(row.claim_amount), kind: "Claim amount", note: `${row.customer_id}, policy ${row.policy_id}` });
    }
  }
  return { inr: Math.round(items.reduce((s, i) => s + i.amount, 0)), items };
}

export async function scoreCase(c: { level: string; score: number }, alerts: AlertRow[], rows?: Map<string, Record<string, unknown>>): Promise<CaseScores> {
  const cfg = policy.priority;
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const lead = alerts.find((a) => a.detector === "FD-06");
  const detectors = [...new Set(members.map((a) => a.detector))].sort();
  const products = [...new Set(alerts.flatMap((a) => a.products))].sort();
  const customers = new Set(alerts.flatMap((a) => a.customer_ids));
  const ato = members.some((a) => a.detector === "FD-03");
  const cross = !!lead;

  const exposure = await exposureFor(alerts, rows);

  const evidenceRefs = [...new Map(members.flatMap((a) => a.evidence).map((r) => [keyOf(r), r])).values()];
  const tables = new Set(evidenceRefs.map((r) => r.table));
  const signals = members.flatMap((a) => a.signals).filter((s) => s.weight > 0);
  const mitigation = members.flatMap((a) => a.mitigations).reduce((s, m) => s + m.weight, 0);
  const signalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const found = rows && evidenceRefs.every((r) => rows.has(keyOf(r))) ? rows : await resolveRefs(evidenceRefs);
  const resolved = evidenceRefs.filter((r) => found.has(keyOf(r))).length;
  const factors = [
    { label: "Independent detectors", value: clamp01(detectors.length / 3), detail: `${detectors.length} detector(s): ${detectors.join(", ") || "none"}` },
    { label: "Source systems", value: clamp01(tables.size / 4), detail: `${tables.size} record type(s): ${[...tables].join(", ") || "none"}` },
    { label: "Supporting records", value: clamp01(evidenceRefs.length / 6), detail: `${evidenceRefs.length} distinct source record(s) cited` },
    { label: "Records resolved", value: evidenceRefs.length ? resolved / evidenceRefs.length : 0, detail: `${resolved} of ${evidenceRefs.length} cited records exist in the workspace` },
    { label: "Contradicting context", value: signalWeight ? 1 - clamp01(mitigation / signalWeight) : 0, detail: mitigation ? `${mitigation} points of legitimate context offset ${signalWeight} points of signals` : "no mitigating context found" },
  ];
  const w = [0.3, 0.2, 0.2, 0.1, 0.2];
  const confidence = Math.round(factors.reduce((s, f, i) => s + f.value * w[i], 0) * 100) / 100;

  const x = Math.log10(1 + exposure.inr) / Math.log10(1 + cfg.exposureCapInr);
  const comps = [
    { label: "Detection risk", value: clamp01(c.score / 100), weight: cfg.weights.risk, detail: `${c.level} risk, score ${c.score}` },
    { label: "Financial exposure", value: clamp01(x), weight: cfg.weights.exposure, detail: `₹${exposure.inr.toLocaleString("en-IN")} across ${exposure.items.length} record(s)` },
    { label: "Diversity of events", value: clamp01((detectors.length + products.length - 1) / 5), weight: cfg.weights.diversity, detail: `${detectors.length} detector(s) across ${products.length} product(s)` },
    { label: "Evidence confidence", value: confidence, weight: cfg.weights.confidence, detail: `${Math.round(confidence * 100)}% confidence` },
    { label: "Account-takeover indicators", value: ato ? 1 : 0, weight: cfg.weights.ato, detail: ato ? "failed-login burst or unfamiliar device before a transfer" : "none" },
    { label: "Cross-system coordination", value: cross ? 1 : 0, weight: cfg.weights.crossSystem, detail: cross ? "alerts from several systems share entities" : "single-system case" },
  ];
  let score = Math.round(comps.reduce((s, k) => s + k.value * k.weight, 0) * 100);
  const lowEvidence = confidence < cfg.needsEvidenceConfidence && !cross;
  if (lowEvidence) score = Math.min(score, 59);
  const tier: CaseScores["priority"]["tier"] = lowEvidence ? "Needs More Evidence" : score >= 75 ? "Critical" : score >= 55 ? "High" : score >= 35 ? "Medium" : "Low";
  return {
    risk: { score: c.score, level: c.level },
    confidence: { score: confidence, factors },
    exposure,
    priority: {
      score, tier, components: comps, needs_more_evidence: lowEvidence,
      reason: lowEvidence ? `Evidence confidence ${Math.round(confidence * 100)}% is below ${Math.round(cfg.needsEvidenceConfidence * 100)}%; collect more records before escalating, whatever the risk score says.` : `Weighted from ${comps.length} explicit components.`,
    },
    indicators: { ato, cross_system: cross, detectors, products, customers: customers.size },
  };
}
