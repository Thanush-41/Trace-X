import { DETECTORS } from "@/lib/policy";
import type { Customer, DetectionContext } from "./context";
import { emptyEntities, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const D = 86400000;

/** Customers that look like one household: shared normalised address, or shared surname and city. */
export function sameHousehold(members: Customer[]): boolean {
  if (members.length < 2) return false;
  const addr = members[0].address_norm;
  if (addr && members.every((m) => m.address_norm === addr)) return true;
  const { surname, city } = members[0];
  return !!surname && !!city && members.every((m) => m.surname === surname && m.city === city);
}

/** Accounts used by two or more of these customers: shared loan payout accounts and shared transfer beneficiaries. */
export function sharedMoneyTrail(ctx: DetectionContext, customerIds: string[]) {
  const group = new Set(customerIds);
  const payoutUsers = new Map<string, Set<string>>();
  const beneficiaryUsers = new Map<string, Set<string>>();
  const evidence = new Map<string, Ref[]>();
  const note = (m: Map<string, Set<string>>, acct: string, cust: string, ref: Ref) => {
    if (!m.has(acct)) m.set(acct, new Set());
    m.get(acct)!.add(cust);
    if (!evidence.has(acct)) evidence.set(acct, []);
    evidence.get(acct)!.push(ref);
  };
  for (const c of customerIds) {
    for (const l of ctx.loansByCustomer.get(c) ?? []) note(payoutUsers, l.payout_account, c, { table: "loan_applications", id: l.application_id });
    for (const a of ctx.accountsByCustomer.get(c) ?? []) {
      for (const t of ctx.outByAccount.get(a.account_id) ?? []) {
        const owner = ctx.ownerOf(t.beneficiary_account);
        if (ctx.isHubAccount(t.beneficiary_account) || (owner && group.has(owner))) continue;
        note(beneficiaryUsers, t.beneficiary_account, c, { table: "transactions", id: t.transaction_id });
      }
    }
  }
  const shared = (m: Map<string, Set<string>>) => [...m].filter(([, users]) => users.size >= 2).map(([acct, users]) => ({ acct, users: [...users] }));
  return { payouts: shared(payoutUsers), beneficiaries: shared(beneficiaryUsers), evidence };
}

export function detectSharedDevices(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd02.params;
  const S = ctx.policy.fd02.signals;
  const M = ctx.policy.fd02.mitigations;
  const findings: Finding[] = [];

  const uses = new Map<string, Map<string, { first: number; last: number; refs: Ref[] }>>();
  const recordUse = (device: string, customer: string, ts: number, ref: Ref) => {
    if (!uses.has(device)) uses.set(device, new Map());
    const byCustomer = uses.get(device)!;
    const u = byCustomer.get(customer) ?? { first: ts, last: ts, refs: [] };
    u.first = Math.min(u.first, ts);
    u.last = Math.max(u.last, ts);
    u.refs.push(ref);
    byCustomer.set(customer, u);
  };
  for (const [device, logins] of ctx.loginsByDevice) for (const l of logins) recordUse(device, l.customer_id, l.ts, { table: "login_events", id: l.event_id });
  for (const l of ctx.loans) if (l.device_id) recordUse(l.device_id, l.customer_id, l.ts, { table: "loan_applications", id: l.application_id });
  for (const c of ctx.claims) if (c.device_id) recordUse(c.device_id, c.customer_id, c.ts, { table: "insurance_claims", id: c.claim_id });

  for (const [device, byCustomer] of uses) {
    if (byCustomer.size < 2 || ctx.isHubDevice(device)) continue;
    const ids = [...byCustomer.keys()].sort();
    const n = ids.length;
    const known = ids.map((c) => ctx.customers.get(c)).filter((c): c is Customer => !!c);
    const allKnown = known.length === n;
    const firsts = ids.map((c) => byCustomer.get(c)!.first);
    const lasts = ids.map((c) => byCustomer.get(c)!.last);
    const span = Math.max(...firsts) - Math.min(...firsts);
    const usePeriod = Math.max(...lasts) - Math.min(...firsts);
    const signals: Rule[] = [];
    const mitigations: Rule[] = [];
    const firstUseRefs = ids.map((c) => byCustomer.get(c)!.refs[0]);
    const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = [], weight?: number) =>
      list.push({ code, label: defs[code].label, weight: weight ?? defs[code].weight, detail, evidence });

    add(signals, "DEVICE_SHARED", S, `${device} was used by ${n} customers: ${ids.join(", ")}`, firstUseRefs);
    if (n >= 3) {
      const def = ctx.policy.fd02.signals.MANY_PROFILES;
      add(signals, "MANY_PROFILES", S, `${n} distinct profiles on one device`, [], Math.min(def.weight + (def.perExtra ?? 0) * (n - 3), def.max ?? 100));
    }
    if (span <= p.clusterFirstUseHours * 3600000) {
      add(signals, "CLUSTERED_FIRST_USE", S, `All ${n} profiles first used the device within ${(span / 3600000).toFixed(1)} h`, firstUseRefs);
    }
    const trail = sharedMoneyTrail(ctx, ids);
    const links = [...trail.payouts.map((x) => `payout account ${x.acct} (${x.users.length} customers)`), ...trail.beneficiaries.map((x) => `beneficiary ${x.acct} (${x.users.length} customers)`)];
    if (links.length > 0) {
      add(signals, "SHARED_MONEY_TRAIL", S, `Shared ${links.join("; ")}`, [...trail.payouts, ...trail.beneficiaries].flatMap((x) => trail.evidence.get(x.acct) ?? []));
    }
    if (allKnown && known.every((c, i) => firsts[i] - c.onboarded < p.newProfileDays * D)) {
      add(signals, "NEW_PROFILES", S, `Every profile was onboarded less than ${p.newProfileDays} days before first using the device`, known.map((c) => ({ table: "customers", id: c.customer_id })));
    }
    const surnames = new Set(known.map((c) => c.surname).filter(Boolean));
    const addresses = new Set(known.map((c) => c.address_norm).filter(Boolean));
    if (allKnown && surnames.size === n && addresses.size === n) {
      add(signals, "UNRELATED_IDENTITIES", S, `No two profiles share a surname or address`, known.map((c) => ({ table: "customers", id: c.customer_id })));
    }

    const raw = signals.reduce((s, r) => s + r.weight, 0);
    if (raw < ctx.policy.recordThreshold) continue;

    if (allKnown && sameHousehold(known)) {
      add(mitigations, "SAME_HOUSEHOLD", M, known[0].address_norm && known.every((c) => c.address_norm === known[0].address_norm)
        ? `All profiles share the address "${known[0].address_norm}"` : `All profiles share the surname "${known[0].surname}" in ${known[0].city}`, known.map((c) => ({ table: "customers", id: c.customer_id })));
    }
    if (usePeriod > p.longStandingDays * D) add(mitigations, "LONG_STANDING_USE", M, `Device used by these profiles over ${Math.round(usePeriod / D)} days`);
    if (links.length === 0) add(mitigations, "NO_MONEY_LINK", M, "No shared payout account or transfer beneficiary between these profiles");

    const sharedPayout = trail.payouts.find((x) => x.users.length >= 3);
    const entities = emptyEntities();
    ids.forEach((c) => entities.customers.add(c));
    entities.devices.add(device);
    for (const x of [...trail.payouts, ...trail.beneficiaries]) entities.accounts.add(x.acct);
    const loanRefs = ids.flatMap((c) => byCustomer.get(c)!.refs.filter((r) => r.table === "loan_applications"));
    loanRefs.forEach((r) => entities.applications.add(r.id));
    const claimRefs = ids.flatMap((c) => byCustomer.get(c)!.refs.filter((r) => r.table === "insurance_claims"));
    claimRefs.forEach((r) => entities.claims.add(r.id));

    findings.push({
      detector: "FD-02",
      category: DETECTORS["FD-02"],
      title: `${n} customers on device ${device}`,
      subject_type: "device",
      subject_id: device,
      primary_ref: firstUseRefs[firstUseRefs.length - 1],
      event_time: new Date(Math.max(...firsts)).toISOString(),
      signals,
      mitigations,
      evidence: uniqueRefs([...ids.map((c) => ({ table: "customers" as const, id: c })), ...signals.flatMap((s) => s.evidence), ...mitigations.flatMap((m) => m.evidence)]),
      entities,
      products: new Set(["banking", ...(loanRefs.length ? ["lending"] : []), ...(claimRefs.length ? ["insurance"] : [])]),
      floor: sharedPayout && !(allKnown && sameHousehold(known))
        ? { min: ctx.policy.floors.sharedPayoutRing, note: `Payout account ${sharedPayout.acct} is shared by ${sharedPayout.users.length} unrelated customers` }
        : undefined,
    });
  }
  return findings;
}
