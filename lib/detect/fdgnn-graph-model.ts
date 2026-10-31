import { DETECTORS } from "@/lib/policy";
import { MODEL } from "@/lib/ml/score";
import type { DetectionContext } from "./context";
import { emptyEntities, type Finding } from "./types";

/**
 * FD-GNN: customers the trained graph model scores above its validated threshold although no rule raised an
 * actionable alert on them. Kept as Low monitored findings, with the model's drivers and graph neighbours as the
 * reason, so the model widens coverage without pushing unexplained output into the case queue.
 */
export function detectGraphModel(ctx: DetectionContext, coveredCustomers: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const g of ctx.graph.values()) {
    if (g.score < MODEL.threshold || coveredCustomers.has(g.customer_id)) continue;
    const ref = { table: "customers" as const, id: g.customer_id };
    const entities = emptyEntities();
    entities.customers.add(g.customer_id);
    (ctx.accountsByCustomer.get(g.customer_id) ?? []).forEach((a) => entities.accounts.add(a.account_id));
    findings.push({
      detector: "FD-GNN",
      category: DETECTORS["FD-GNN"],
      title: `Graph model scores ${g.customer_id} at ${Math.round(g.score * 100)}% (model-only)`,
      subject_type: "customer",
      subject_id: g.customer_id,
      primary_ref: ref,
      event_time: new Date(ctx.customers.get(g.customer_id)?.onboarded || Date.now()).toISOString(),
      signals: [{
        code: "GNN_ONLY", label: "Graph model risk, no rule fired", weight: 25,
        detail: `${MODEL.name} probability ${g.score.toFixed(2)} (threshold ${MODEL.threshold})${g.drivers.length ? `; driven by ${g.drivers.join(", ")}` : ""}${g.neighbours.length ? `; linked to ${g.neighbours.slice(0, 3).map((n) => `${n.customer_id} via ${n.via[0]}`).join(", ")}` : ""}`,
        evidence: [ref, ...g.neighbours.slice(0, 3).map((n) => ({ table: "customers" as const, id: n.customer_id }))],
      }],
      mitigations: [],
      evidence: [ref, ...g.neighbours.slice(0, 3).map((n) => ({ table: "customers" as const, id: n.customer_id }))],
      entities,
      products: new Set(["banking"]),
    });
  }
  return findings;
}
