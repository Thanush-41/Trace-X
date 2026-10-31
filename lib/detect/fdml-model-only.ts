import { DETECTORS } from "@/lib/policy";
import type { DetectionContext } from "./context";
import { emptyEntities, fmtINR, type Finding } from "./types";

/**
 * FD-ML: transfers the isolation forest ranks in the top tail although no rule fired on them.
 * Stored as Low "monitored" findings: the model widens coverage beyond the rules without
 * pushing unexplained model output into the case queue.
 */
export function detectModelOnly(ctx: DetectionContext, coveredTransactions: Set<string>): Finding[] {
  const ml = ctx.policy.ml;
  const findings: Finding[] = [];
  for (const [accountId, outgoing] of ctx.outByAccount) {
    const account = ctx.accounts.get(accountId)!;
    for (const t of outgoing) {
      const a = ctx.anomaly.get(t.transaction_id);
      if (!a || a.percentile < ml.modelOnlyPercentile || coveredTransactions.has(t.transaction_id)) continue;
      const ref = { table: "transactions" as const, id: t.transaction_id };
      const entities = emptyEntities();
      entities.customers.add(account.customer_id);
      entities.accounts.add(accountId).add(t.beneficiary_account);
      entities.transactions.add(t.transaction_id);
      findings.push({
        detector: "FD-ML",
        category: DETECTORS["FD-ML"],
        title: `${fmtINR(t.amount)} from ${accountId} to ${t.beneficiary_account} (model-only)`,
        subject_type: "transaction",
        subject_id: t.transaction_id,
        primary_ref: ref,
        event_time: t.timestamp,
        signals: [{
          code: "ML_ONLY",
          label: ml.modelOnly.label,
          weight: ml.modelOnly.weight,
          detail: `Isolation-forest score ${a.score.toFixed(2)}, higher than ${a.percentile}% of ${ctx.anomaly.size} transfers${a.drivers.length ? `; most unusual: ${a.drivers.join(", ")}` : ""}. No rule matched, so it is kept as a monitored signal for review.`,
          evidence: [ref],
        }],
        mitigations: [],
        evidence: [ref, { table: "accounts", id: accountId }, { table: "customers", id: account.customer_id }],
        entities,
        products: new Set([account.product]),
      });
    }
  }
  return findings;
}
