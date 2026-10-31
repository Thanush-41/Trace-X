import type { DetectionContext } from "@/lib/detect/context";
import type { GroundTruth } from "@/lib/detect/evaluate";

/**
 * Customer labels from an answer key, used only by training and evaluation (never by detection).
 * A customer is positive when a planted fraud scenario names them, their account, their transaction, their
 * application or their claim. Lookalike customers stay negative, which is what teaches the model the difference.
 */
export function customerLabels(ctx: DetectionContext, truth: GroundTruth): Map<string, number> {
  const pos = new Set<string>();
  const txnOwner = new Map<string, string>();
  for (const [acc, ts] of ctx.outByAccount) for (const t of ts) { const o = ctx.ownerOf(acc); if (o) txnOwner.set(t.transaction_id, o); }
  const appOwner = new Map(ctx.loans.map((l) => [l.application_id, l.customer_id]));
  const claimOwner = new Map(ctx.claims.map((c) => [c.claim_id, c.customer_id]));
  for (const item of truth.items) {
    if (item.kind !== "fraud" || item.detector === "FD-06") continue;
    const e = item.entities;
    (e.customer_ids ?? []).forEach((c) => pos.add(c));
    (e.account_ids ?? []).forEach((a) => { const o = ctx.ownerOf(a); if (o) pos.add(o); });
    (e.transaction_ids ?? []).forEach((t) => { const o = txnOwner.get(t); if (o) pos.add(o); });
    (e.application_ids ?? []).forEach((a) => { const o = appOwner.get(a); if (o) pos.add(o); });
    (e.claim_ids ?? []).forEach((c) => { const o = claimOwner.get(c); if (o) pos.add(o); });
  }
  return new Map([...ctx.customers.keys()].map((c) => [c, pos.has(c) ? 1 : 0]));
}
