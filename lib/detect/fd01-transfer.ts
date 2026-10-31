import { DETECTORS } from "@/lib/policy";
import { quantile, median, robustZ } from "@/lib/util/stats";
import type { DetectionContext, Login, Txn } from "./context";
import { emptyEntities, fmtINR, fmtMinutes, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const H = 3600000;
const D = 24 * H;
const SENSITIVE_EVENTS = new Set(["password_reset", "device_change", "profile_change", "beneficiary_add"]);

const txnRef = (t: Txn): Ref => ({ table: "transactions", id: t.transaction_id });
const loginRef = (l: Login): Ref => ({ table: "login_events", id: l.event_id });

/** Earlier transfers from the same account to the same beneficiary. */
export function priorToBeneficiary(ctx: DetectionContext, t: Txn): Txn[] {
  return (ctx.outByAccount.get(t.account_id) ?? []).filter((p) => p.ts < t.ts && p.beneficiary_account === t.beneficiary_account);
}

/** Whether "new beneficiary" is meaningful: the account is new, or has enough history to know its payees. */
export function isNewBeneficiary(ctx: DetectionContext, t: Txn): boolean {
  // Paying a widely used payee (utility, retailer) for the first time is ordinary.
  if (ctx.isHubAccount(t.beneficiary_account)) return false;
  const p = ctx.policy.fd01.params;
  const prior = (ctx.outByAccount.get(t.account_id) ?? []).filter((x) => x.ts < t.ts);
  const acc = ctx.accounts.get(t.account_id);
  const young = acc ? t.ts - acc.opened < p.newAccountWindowDays * D : false;
  return (young || prior.length >= p.newBeneficiaryMinHistory) && priorToBeneficiary(ctx, t).length === 0;
}

/** Baseline = this account's earlier outgoing transfers, excluding the last 24 h so a burst cannot dilute itself. */
export function baseline(ctx: DetectionContext, t: Txn): number[] {
  const gap = ctx.policy.fd01.params.baselineGapHours * H;
  return (ctx.outByAccount.get(t.account_id) ?? []).filter((x) => x.ts < t.ts - gap).map((x) => x.amount);
}

export function isAmountOutlier(ctx: DetectionContext, t: Txn, history = baseline(ctx, t)): boolean {
  const p = ctx.policy.fd01.params;
  return history.length >= p.minHistory && robustZ(t.amount, history) > p.zThreshold && t.amount > p.p95Multiple * quantile(history, 0.95);
}

/** Risky login activity by the account owner shortly before an event. */
export function loginRiskBefore(ctx: DetectionContext, customer: string, at: number, windowMs: number) {
  const logins = ctx.loginsByCustomer.get(customer) ?? [];
  const inWindow = logins.filter((l) => l.ts <= at && l.ts >= at - windowMs);
  const failures = inWindow.filter((l) => l.outcome === "failure");
  const reasons: string[] = [];
  const evidence: Login[] = [];
  if (failures.length >= ctx.policy.fd01.params.loginRiskFailures) {
    reasons.push(`${failures.length} failed logins`);
    evidence.push(...failures);
  }
  for (const l of inWindow) {
    if (l.outcome !== "success") continue;
    const earlier = logins.filter((x) => x.ts < l.ts && x.outcome === "success");
    // A new device on its own is common (new phone); it counts as risk only with a new location or network.
    const newDevice = earlier.length > 0 && !earlier.some((x) => x.device_id === l.device_id);
    const newPlace = l.geo ? !earlier.some((x) => x.geo === l.geo) : !!l.ip_address && !earlier.some((x) => x.ip_address === l.ip_address);
    if (newDevice && newPlace) {
      reasons.push(`login from new device ${l.device_id} in a new location (${l.geo ?? l.ip_address})`);
      evidence.push(l);
    }
    if (l.event_type === "password_reset" || l.event_type === "device_change") {
      reasons.push(l.event_type.replace("_", " "));
      evidence.push(l);
    }
  }
  return { risky: reasons.length > 0, reasons: [...new Set(reasons)], evidence };
}

export function detectSuspiciousTransfers(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd01.params;
  const S = ctx.policy.fd01.signals;
  const M = ctx.policy.fd01.mitigations;
  const findings: Finding[] = [];

  for (const [accountId, outgoing] of ctx.outByAccount) {
    const account = ctx.accounts.get(accountId)!;
    const customer = account.customer_id;
    for (const t of outgoing) {
      if (t.status === "reversed") continue;
      const signals: Rule[] = [];
      const mitigations: Rule[] = [];
      const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = []) =>
        list.push({ code, label: defs[code].label, weight: defs[code].weight, detail, evidence });

      const historyTxns = outgoing.filter((x) => x.ts < t.ts - p.baselineGapHours * H);
      const history = historyTxns.map((x) => x.amount);
      const priorAll = outgoing.filter((x) => x.ts < t.ts);
      const ageDays = (t.ts - account.opened) / D;
      const young = ageDays < p.newAccountWindowDays;

      if (t.amount >= p.highValueAbsolute) add(signals, "HIGH_VALUE", S, `${fmtINR(t.amount)} is at or above the ${fmtINR(p.highValueAbsolute)} high-value threshold`, [txnRef(t)]);
      if (isAmountOutlier(ctx, t, history)) {
        add(signals, "AMOUNT_OUTLIER", S, `${fmtINR(t.amount)} is ${(t.amount / median(history)).toFixed(1)}× this account's median (${fmtINR(median(history))}) and ${(t.amount / quantile(history, 0.95)).toFixed(1)}× its 95th percentile over ${history.length} earlier transfers`, [txnRef(t), ...historyTxns.slice(-10).map(txnRef)]);
      } else if (priorAll.length < p.minHistory && t.amount >= p.noHistoryLargeAmount && young) {
        add(signals, "NO_HISTORY_LARGE", S, `${fmtINR(t.amount)} from an account ${Math.floor(ageDays)} days old with only ${priorAll.length} earlier transfers`, [txnRef(t), { table: "accounts", id: accountId }]);
      }
      if (isNewBeneficiary(ctx, t)) add(signals, "NEW_BENEFICIARY", S, `First transfer from ${accountId} to ${t.beneficiary_account}${t.beneficiary_name ? ` (${t.beneficiary_name})` : ""}`, [txnRef(t)]);

      const burst = outgoing.filter((x) => x.ts <= t.ts && x.ts >= t.ts - p.rapidWindowMin * 60000);
      if (burst.length >= p.rapidCount) add(signals, "RAPID_SUCCESSION", S, `${burst.length} outgoing transfers within ${fmtMinutes(t.ts - burst[0].ts)}`, burst.map(txnRef));

      if (history.length >= p.unusualChannelMinHistory) {
        const gap = p.baselineGapHours * H;
        const baseTxns = outgoing.filter((x) => x.ts < t.ts - gap);
        const share = baseTxns.filter((x) => x.channel === t.channel).length / baseTxns.length;
        if (share < p.unusualChannelShare) add(signals, "UNUSUAL_CHANNEL", S, `Channel "${t.channel}" was used for ${(share * 100).toFixed(0)}% of ${baseTxns.length} earlier transfers`, [txnRef(t), ...baseTxns.slice(-10).map(txnRef)]);
      }
      if (ageDays < p.newAccountDays) add(signals, "NEW_ACCOUNT", S, `Account opened ${ageDays < 1 ? "less than a day" : `${Math.floor(ageDays)} days`} before this transfer`, [txnRef(t), { table: "accounts", id: accountId }]);

      const inflows = (ctx.inByAccount.get(accountId) ?? []).filter((x) => x.ts <= t.ts && x.ts >= t.ts - p.drainInWindowDays * D);
      const inflowSum = inflows.reduce((s, x) => s + x.amount, 0);
      const recentOut = outgoing.filter((x) => x.ts <= t.ts && x.ts >= t.ts - p.drainOutWindowH * H);
      const outSum = recentOut.reduce((s, x) => s + x.amount, 0);
      if (inflowSum >= p.drainMinInflow && outSum >= p.drainShare * inflowSum) {
        add(signals, "DRAIN", S, `${fmtINR(outSum)} sent out within ${p.drainOutWindowH} h after ${fmtINR(inflowSum)} came in during the previous ${p.drainInWindowDays} days (${Math.round((outSum / inflowSum) * 100)}%)`, [...inflows, ...recentOut].map(txnRef));
      }

      const risk = loginRiskBefore(ctx, customer, t.ts, p.loginRiskWindowMin * 60000);
      if (risk.risky) add(signals, "PRECEDED_BY_LOGIN_RISK", S, `In the ${p.loginRiskWindowMin} min before: ${risk.reasons.join(", ")}`, risk.evidence.map(loginRef));

      const senders = ctx.sendersByBeneficiary.get(t.beneficiary_account) ?? [];
      const recentSenders = new Set(senders.filter((s) => s.ts <= t.ts && s.ts >= t.ts - p.muleWindowH * H).map((s) => s.customer));
      const priorSenders = new Set(senders.filter((s) => s.ts < t.ts - p.muleWindowH * H).map((s) => s.customer));
      if (!ctx.isHubAccount(t.beneficiary_account) && recentSenders.size >= p.muleSenders && priorSenders.size <= p.muleMaxPriorSenders) {
        const contributing = senders.filter((s) => s.ts <= t.ts && s.ts >= t.ts - p.muleWindowH * H).map((s) => ({ table: "transactions" as const, id: s.transaction_id }));
        add(signals, "MULE_FAN_IN", S, `${t.beneficiary_account} received from ${recentSenders.size} different customers within ${p.muleWindowH} h (only ${priorSenders.size} before that)`, contributing);
      }

      const raw = signals.reduce((s, r) => s + r.weight, 0);
      if (raw < ctx.policy.recordThreshold) continue;

      if (history.length >= p.normMinHistory && t.amount <= p.normP95Multiple * quantile(history, 0.95)) {
        add(mitigations, "WITHIN_CUSTOMER_NORM", M, `${fmtINR(t.amount)} is within ${p.normP95Multiple}× of this account's 95th percentile (${fmtINR(quantile(history, 0.95))}) over ${history.length} earlier transfers`, [txnRef(t), ...historyTxns.slice(-10).map(txnRef)]);
      }
      const toBen = priorToBeneficiary(ctx, t);
      if (toBen.length >= p.establishedBeneficiaryCount) {
        add(mitigations, "ESTABLISHED_BENEFICIARY", M, `${toBen.length} earlier transfers to ${t.beneficiary_account}, the first on ${toBen[0].timestamp.slice(0, 10)}`, toBen.slice(-3).map(txnRef));
      }
      if (ageDays > p.longTenureDays && !risk.risky) add(mitigations, "LONG_TENURE", M, `Account open for ${Math.floor(ageDays / 365)} year(s); no risky login activity before the transfer`, [{ table: "accounts", id: accountId }, txnRef(t)]);

      const entities = emptyEntities();
      entities.customers.add(customer);
      entities.accounts.add(accountId).add(t.beneficiary_account);
      entities.transactions.add(t.transaction_id);
      const benOwner = ctx.ownerOf(t.beneficiary_account);
      if (benOwner) entities.customers.add(benOwner);

      findings.push({
        detector: "FD-01",
        category: DETECTORS["FD-01"],
        title: `${fmtINR(t.amount)} from ${accountId} to ${t.beneficiary_account}`,
        subject_type: "transaction",
        subject_id: t.transaction_id,
        primary_ref: txnRef(t),
        event_time: t.timestamp,
        signals,
        mitigations,
        evidence: uniqueRefs([txnRef(t), { table: "accounts", id: accountId }, { table: "customers", id: customer }, ...signals.flatMap((s) => s.evidence), ...mitigations.flatMap((m) => m.evidence)]),
        entities,
        products: new Set([account.product]),
      });
    }
  }
  return findings;
}

export { SENSITIVE_EVENTS };
