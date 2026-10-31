import { DETECTORS } from "@/lib/policy";
import type { Claim, Customer, DetectionContext } from "./context";
import { sameHousehold } from "./fd02-device";
import { emptyEntities, fmtINR, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const D = 86400000;
const claimRef = (c: Claim): Ref => ({ table: "insurance_claims", id: c.claim_id });

/**
 * FD-07: insurance claim red flags, scored together because one flag alone is rarely meaningful
 * (industry guidance treats several co-occurring indicators as the trigger for investigation).
 */
export function detectClaimFraud(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd07.params;
  const S = ctx.policy.fd07.signals;
  const M = ctx.policy.fd07.mitigations;
  const findings: Finding[] = [];

  const byDoc = new Map<string, Claim[]>();
  const byProvider = new Map<string, Claim[]>();
  const payoutUsers = new Map<string, Set<string>>();
  const addUser = (acct: string, cust: string) => {
    if (!payoutUsers.has(acct)) payoutUsers.set(acct, new Set());
    payoutUsers.get(acct)!.add(cust);
  };
  for (const c of ctx.claims) {
    if (c.document_hash) byDoc.set(c.document_hash, [...(byDoc.get(c.document_hash) ?? []), c]);
    if (c.provider_id) byProvider.set(c.provider_id, [...(byProvider.get(c.provider_id) ?? []), c]);
    addUser(c.payout_account, c.customer_id);
  }
  for (const l of ctx.loans) addUser(l.payout_account, l.customer_id);
  for (const a of ctx.accounts.values()) addUser(a.account_id, a.customer_id);

  const people = (ids: Iterable<string>) => [...ids].map((id) => ctx.customers.get(id)).filter((c): c is Customer => !!c);

  for (const c of ctx.claims) {
    const signals: Rule[] = [];
    const mitigations: Rule[] = [];
    const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = []) =>
      list.push({ code, label: defs[code].label, weight: defs[code].weight, detail, evidence });
    const linked = new Set<Claim>();
    const claimant = ctx.customers.get(c.customer_id);

    const sameDoc = c.document_hash ? (byDoc.get(c.document_hash) ?? []).filter((x) => x !== c) : [];
    if (sameDoc.length) {
      sameDoc.forEach((x) => linked.add(x));
      add(signals, "DUPLICATE_DOCUMENT", S, `Document ${c.document_hash} is also attached to ${sameDoc.map((x) => `${x.claim_id} (${x.customer_id}, policy ${x.policy_id})`).join(", ")}`, sameDoc.map(claimRef));
    }
    const sameIncident = (ctx.claimsByCustomer.get(c.customer_id) ?? []).filter((x) => x !== c && x.claim_type === c.claim_type
      && Math.abs(x.incident - c.incident) <= p.duplicateWindowDays * D
      && Math.abs(x.claim_amount - c.claim_amount) <= p.duplicateAmountTolerance * Math.max(x.claim_amount, c.claim_amount));
    if (sameIncident.length) {
      sameIncident.forEach((x) => linked.add(x));
      add(signals, "DUPLICATE_INCIDENT", S, `${c.claim_type} loss on ${c.incident_date.slice(0, 10)} for ${fmtINR(c.claim_amount)} is also claimed as ${sameIncident.map((x) => `${x.claim_id} on policy ${x.policy_id} (${fmtINR(x.claim_amount)})`).join(", ")}`, sameIncident.map(claimRef));
    }

    const others = [...(payoutUsers.get(c.payout_account) ?? [])].filter((id) => id !== c.customer_id);
    const sharedPayout = others.length > 0 && others.length <= ctx.policy.hubDegree;
    const household = sharedPayout && !!claimant && sameHousehold([claimant, ...people(others)]);
    if (sharedPayout) {
      add(signals, "SHARED_PAYOUT_ACCOUNT", S, `Payout account ${c.payout_account} is also used or owned by ${others.join(", ")}`);
    }

    const start = c.policy_start_date ? Date.parse(c.policy_start_date) : ctx.accounts.get(c.policy_id)?.opened;
    const policyAgeDays = start !== undefined && !isNaN(start) ? (c.incident - start) / D : null;
    if (policyAgeDays !== null && policyAgeDays >= 0 && policyAgeDays < p.earlyClaimDays) {
      add(signals, "EARLY_CLAIM", S, `Loss ${Math.floor(policyAgeDays)} days after policy ${c.policy_id} started`);
    }
    if (c.sum_insured && c.claim_amount >= p.nearSumInsuredShare * c.sum_insured) {
      add(signals, "NEAR_SUM_INSURED", S, `${fmtINR(c.claim_amount)} is ${Math.round((c.claim_amount / c.sum_insured) * 100)}% of the ${fmtINR(c.sum_insured)} sum insured`);
    }
    const delay = (c.ts - c.incident) / D;
    if (delay > p.lateReportingDays) add(signals, "LATE_REPORTING", S, `Reported ${Math.round(delay)} days after the incident`);

    const recent = (ctx.claimsByCustomer.get(c.customer_id) ?? []).filter((x) => x.ts <= c.ts && x.ts >= c.ts - p.frequencyWindowDays * D);
    if (recent.length >= p.frequencyCount) add(signals, "CLAIM_FREQUENCY", S, `${recent.length} claims by ${c.customer_id} in ${p.frequencyWindowDays} days`, recent.map(claimRef));

    if (c.provider_id) {
      const near = (byProvider.get(c.provider_id) ?? []).filter((x) => Math.abs(x.incident - c.incident) <= p.providerWindowDays * D);
      const claimants = people(new Set(near.map((x) => x.customer_id)));
      if (claimants.length >= p.providerSameDayClaimants && !sameHousehold(claimants)) {
        near.filter((x) => x !== c).forEach((x) => linked.add(x));
        add(signals, "PROVIDER_SAME_DAY", S, `${c.provider_id} has ${claimants.length} different claimants with losses within ${p.providerWindowDays} days`, near.map(claimRef));
      }
    }

    const raw = signals.reduce((s, r) => s + r.weight, 0);
    if (raw < ctx.policy.recordThreshold) continue;

    if (household) add(mitigations, "SAME_HOUSEHOLD", M, `Everyone using ${c.payout_account} belongs to the claimant's household`);
    const earlier = (ctx.claimsByCustomer.get(c.customer_id) ?? []).filter((x) => x.ts < c.ts);
    if (policyAgeDays !== null && policyAgeDays > p.cleanHistoryYears * 365 && earlier.length === 0) {
      add(mitigations, "CLEAN_HISTORY", M, `Policy in force for ${Math.floor(policyAgeDays / 365)} years with no earlier claims`);
    }

    const entities = emptyEntities();
    entities.customers.add(c.customer_id);
    entities.claims.add(c.claim_id);
    linked.forEach((x) => { entities.claims.add(x.claim_id); entities.customers.add(x.customer_id); });
    if (sharedPayout && !household) {
      entities.accounts.add(c.payout_account);
      others.forEach((o) => entities.customers.add(o));
    }
    if (c.device_id && !ctx.isHubDevice(c.device_id)) entities.devices.add(c.device_id);
    const payoutProduct = ctx.accounts.get(c.payout_account)?.product;

    findings.push({
      detector: "FD-07",
      category: DETECTORS["FD-07"],
      title: `${c.claim_type} claim ${c.claim_id}: ${fmtINR(c.claim_amount)} by ${c.customer_id}`,
      subject_type: "claim",
      subject_id: c.claim_id,
      primary_ref: claimRef(c),
      event_time: c.submitted_at,
      signals,
      mitigations,
      evidence: uniqueRefs([claimRef(c), { table: "customers", id: c.customer_id }, ...[...linked].map(claimRef), ...signals.flatMap((s) => s.evidence),
        ...(ctx.accounts.has(c.payout_account) ? [{ table: "accounts" as const, id: c.payout_account }] : [])]),
      entities,
      products: new Set(["insurance", ...(payoutProduct && payoutProduct !== "insurance" ? [payoutProduct] : [])]),
    });
  }
  return findings;
}
