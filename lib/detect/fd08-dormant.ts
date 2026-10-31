import { DETECTORS } from "@/lib/policy";
import type { DetectionContext, Txn } from "./context";
import { emptyEntities, fmtINR, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const D = 86400000;
const txnRef = (t: Txn): Ref => ({ table: "transactions", id: t.transaction_id });

/**
 * FD-08: an account with no activity for months that suddenly receives money and passes it on is a
 * classic mule pattern. A salary account resuming with small payments to known payees is the lookalike.
 */
export function detectDormantReactivation(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd08.params;
  const S = ctx.policy.fd08.signals;
  const M = ctx.policy.fd08.mitigations;
  const findings: Finding[] = [];
  for (const account of ctx.accounts.values()) {
    const out = ctx.outByAccount.get(account.account_id) ?? [];
    const inn = ctx.inByAccount.get(account.account_id) ?? [];
    const activity = [...out.map((t) => ({ t, dir: "out" as const })), ...inn.map((t) => ({ t, dir: "in" as const }))].sort((a, b) => a.t.ts - b.t.ts);
    for (let i = 1; i < activity.length; i++) {
      const gap = activity[i].t.ts - activity[i - 1].t.ts;
      if (gap < p.dormantDays * D) continue;
      const start = activity[i].t.ts;
      const windowAct = activity.filter((a) => a.t.ts >= start && a.t.ts <= start + p.windowHours * 3600000);
      const inflows = windowAct.filter((a) => a.dir === "in").map((a) => a.t);
      const outflows = windowAct.filter((a) => a.dir === "out").map((a) => a.t);
      const inSum = inflows.reduce((s, t) => s + t.amount, 0);
      const outSum = outflows.reduce((s, t) => s + t.amount, 0);
      const before = out.filter((t) => t.ts < start);
      const paidBefore = new Set(before.map((t) => t.beneficiary_account));
      const newPayees = outflows.filter((t) => !paidBefore.has(t.beneficiary_account) && !ctx.isHubAccount(t.beneficiary_account));
      const signals: Rule[] = [];
      const mitigations: Rule[] = [];
      const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[]) =>
        list.push({ code, label: defs[code].label, weight: defs[code].weight, detail, evidence });
      add(signals, "DORMANT_REACTIVATED", S, `No activity for ${Math.round(gap / D)} days (${activity[i - 1].t.timestamp.slice(0, 10)} to ${activity[i].t.timestamp.slice(0, 10)})`, [txnRef(activity[i - 1].t), txnRef(activity[i].t)]);
      if (inSum >= p.largeInflow) add(signals, "LARGE_INFLOW", S, `${fmtINR(inSum)} received within ${p.windowHours} h of reactivation`, inflows.map(txnRef));
      if (inSum > 0 && outSum >= p.outflowShare * inSum) add(signals, "RAPID_PASS_THROUGH", S, `${fmtINR(outSum)} (${Math.round((outSum / inSum) * 100)}% of inflows) sent out within ${p.windowHours} h`, [...inflows, ...outflows].map(txnRef));
      if (newPayees.length) add(signals, "NEW_PAYEES", S, `${newPayees.length} outflow(s) to payees never paid before: ${[...new Set(newPayees.map((t) => t.beneficiary_account))].slice(0, 3).join(", ")}`, newPayees.map(txnRef));
      const raw = signals.reduce((s, r) => s + r.weight, 0);
      if (raw < ctx.policy.recordThreshold) break;
      if (outflows.length && newPayees.length === 0) add(mitigations, "KNOWN_PAYEES", M, "Every outflow after reactivation went to a payee paid before the dormancy", outflows.map(txnRef));
      if (outflows.length && outSum < p.smallOutflow) add(mitigations, "SMALL_AMOUNTS", M, `Outflows total ${fmtINR(outSum)}`, outflows.map(txnRef));
      const entities = emptyEntities();
      entities.customers.add(account.customer_id);
      entities.accounts.add(account.account_id);
      for (const t of [...inflows, ...outflows]) {
        entities.transactions.add(t.transaction_id);
        if (t.beneficiary_account !== account.account_id) entities.accounts.add(t.beneficiary_account);
      }
      findings.push({
        detector: "FD-08",
        category: DETECTORS["FD-08"],
        title: `Account ${account.account_id} reactivated after ${Math.round(gap / D)} days`,
        subject_type: "transaction",
        subject_id: activity[i].t.transaction_id,
        primary_ref: txnRef(activity[i].t),
        event_time: activity[i].t.timestamp,
        signals,
        mitigations,
        evidence: uniqueRefs([{ table: "accounts", id: account.account_id }, { table: "customers", id: account.customer_id }, ...signals.flatMap((s) => s.evidence), ...mitigations.flatMap((m) => m.evidence)]),
        entities,
        products: new Set([account.product]),
      });
      break;
    }
  }
  return findings;
}
