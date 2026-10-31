import { DETECTORS } from "@/lib/policy";
import { UnionFind } from "@/lib/util/unionfind";
import type { Customer, DetectionContext, Loan } from "./context";
import { sameHousehold } from "./fd02-device";
import { emptyEntities, fmtINR, uniqueRefs, type Finding, type Ref, type Rule } from "./types";

const D = 86400000;
const loanRef = (l: Loan): Ref => ({ table: "loan_applications", id: l.application_id });

type LinkKind = "device" | "phone" | "email" | "payout" | "national_id";

/** Identity attributes of one application, falling back to the applicant's profile for contact details. */
function attributes(ctx: DetectionContext, l: Loan): [LinkKind, string][] {
  const c = ctx.customers.get(l.customer_id);
  const out: [LinkKind, string][] = [["payout", l.payout_account]];
  if (l.device_id) out.push(["device", l.device_id]);
  const phone = l.phone_norm ?? c?.phone_norm;
  const email = l.email_norm ?? c?.email_norm;
  if (phone) out.push(["phone", phone]);
  if (email) out.push(["email", email]);
  if (c?.national_id) out.push(["national_id", c.national_id]);
  return out;
}

export function detectLoanRings(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd05.params;
  const S = ctx.policy.fd05.signals;
  const M = ctx.policy.fd05.mitigations;
  const findings: Finding[] = [];

  // attribute value → applications using it
  const byAttr = new Map<string, Loan[]>();
  for (const l of ctx.loans) {
    for (const [kind, value] of attributes(ctx, l)) {
      const k = `${kind}:${value}`;
      if (!byAttr.has(k)) byAttr.set(k, []);
      byAttr.get(k)!.push(l);
    }
  }
  const uf = new UnionFind<string>();
  const loansById = new Map(ctx.loans.map((l) => [l.application_id, l]));
  const sharedAttrs: { kind: LinkKind; value: string; loans: Loan[] }[] = [];
  for (const [k, loans] of byAttr) {
    loans.forEach((l) => uf.add(l.application_id));
    const customers = new Set(loans.map((l) => l.customer_id));
    if (customers.size < 2 || customers.size > ctx.policy.hubDegree) continue;
    const [kind, ...rest] = k.split(":");
    sharedAttrs.push({ kind: kind as LinkKind, value: rest.join(":"), loans });
    for (let i = 1; i < loans.length; i++) uf.union(loans[0].application_id, loans[i].application_id);
  }

  for (const groupIds of uf.groups()) {
    const loans = groupIds.map((id) => loansById.get(id)!).sort((a, b) => a.ts - b.ts);
    const customerIds = [...new Set(loans.map((l) => l.customer_id))].sort();
    if (customerIds.length < 2) continue;
    const inGroup = new Set(groupIds);
    const links = sharedAttrs.filter((a) => a.loans.every((l) => inGroup.has(l.application_id)));
    const linksOf = (kinds: LinkKind[]) => links.filter((a) => kinds.includes(a.kind));
    const customersOf = (ls: Loan[]) => new Set(ls.map((l) => l.customer_id)).size;

    const signals: Rule[] = [];
    const mitigations: Rule[] = [];
    const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[] = []) =>
      list.push({ code, label: defs[code].label, weight: defs[code].weight, detail, evidence });

    const payouts = linksOf(["payout"]);
    if (payouts.length) add(signals, "SHARED_PAYOUT_ACCOUNT", S, payouts.map((a) => `${a.value} receives payouts for ${customersOf(a.loans)} customers`).join("; "), payouts.flatMap((a) => a.loans.map(loanRef)));
    const devices = linksOf(["device"]);
    if (devices.length) add(signals, "SHARED_DEVICE", S, devices.map((a) => `${a.value} submitted applications for ${customersOf(a.loans)} customers`).join("; "), devices.flatMap((a) => a.loans.map(loanRef)));
    const contacts = linksOf(["phone", "email"]);
    if (contacts.length) add(signals, "SHARED_CONTACT", S, contacts.map((a) => `${a.kind} ${a.value} used by ${customersOf(a.loans)} customers`).join("; "), contacts.flatMap((a) => a.loans.map(loanRef)));

    const idReuse = linksOf(["national_id"]).filter((a) => {
      const people = [...new Set(a.loans.map((l) => l.customer_id))].map((c) => ctx.customers.get(c)).filter((c): c is Customer => !!c);
      return new Set(people.map((c) => c.name_norm)).size > 1 || new Set(people.map((c) => c.dob)).size > 1;
    });
    if (idReuse.length) add(signals, "ID_REUSE", S, idReuse.map((a) => `National ID ${a.value} appears under different names or dates of birth`).join("; "), idReuse.flatMap((a) => a.loans.map((l) => ({ table: "customers" as const, id: l.customer_id }))));

    let maxInWindow = 0;
    for (let i = 0; i < loans.length; i++) {
      const n = loans.filter((l) => l.ts >= loans[i].ts && l.ts <= loans[i].ts + p.velocityWindowDays * D).length;
      maxInWindow = Math.max(maxInWindow, n);
    }
    if (maxInWindow >= p.velocityCount) add(signals, "APPLICATION_VELOCITY", S, `${maxInWindow} linked applications within ${p.velocityWindowDays} days`, loans.map(loanRef));

    const inflated = loans.filter((l) => {
      const profile = ctx.customers.get(l.customer_id)?.declared_income;
      return l.declared_income && profile && l.declared_income >= p.incomeMismatchRatio * profile;
    });
    if (inflated.length) add(signals, "INCOME_MISMATCH", S, inflated.map((l) => `${l.application_id} states ${fmtINR(l.declared_income!)} a year vs ${fmtINR(ctx.customers.get(l.customer_id)!.declared_income!)} on the customer profile`).join("; "), inflated.flatMap((l) => [loanRef(l), { table: "customers" as const, id: l.customer_id }]));

    const known = customerIds.map((c) => ctx.customers.get(c)).filter((c): c is Customer => !!c);
    const allKnown = known.length === customerIds.length;
    if (allKnown && loans.every((l) => {
      const age = l.ts - ctx.customers.get(l.customer_id)!.onboarded;
      return age >= 0 && age < p.newProfileDays * D;
    })) {
      add(signals, "NEW_PROFILES", S, `Every applicant was onboarded less than ${p.newProfileDays} days before applying`, known.map((c) => ({ table: "customers", id: c.customer_id })));
    }

    const raw = signals.reduce((s, r) => s + r.weight, 0);
    if (raw < ctx.policy.recordThreshold) continue;

    const household = allKnown && sameHousehold(known);
    if (household && payouts.length === 0 && idReuse.length === 0) {
      add(mitigations, "SAME_HOUSEHOLD", M, "Applicants share a household and no payout account or identity number", known.map((c) => ({ table: "customers", id: c.customer_id })));
    }

    const entities = emptyEntities();
    customerIds.forEach((c) => entities.customers.add(c));
    for (const l of loans) {
      entities.applications.add(l.application_id);
      if (l.device_id && devices.some((d) => d.value === l.device_id)) entities.devices.add(l.device_id);
    }
    payouts.forEach((a) => entities.accounts.add(a.value));
    const total = loans.reduce((s, l) => s + l.requested_amount, 0);
    const ringPayout = payouts.find((a) => customersOf(a.loans) >= 3);

    findings.push({
      detector: "FD-05",
      category: DETECTORS["FD-05"],
      title: `${loans.length} linked loan applications from ${customerIds.length} customers (${fmtINR(total)})`,
      subject_type: "application_group",
      subject_id: loans[0].application_id,
      primary_ref: loanRef(loans[loans.length - 1]),
      event_time: loans[loans.length - 1].submitted_at,
      signals,
      mitigations,
      evidence: uniqueRefs([...loans.map(loanRef), ...customerIds.map((c) => ({ table: "customers" as const, id: c })), ...signals.flatMap((s) => s.evidence)]),
      entities,
      products: new Set(["lending"]),
      floor: ringPayout && !household ? { min: ctx.policy.floors.sharedPayoutRing, note: `Payout account ${ringPayout.value} is shared by ${customersOf(ringPayout.loans)} unrelated applicants` } : undefined,
    });
  }
  return findings;
}
