import { DETECTORS } from "@/lib/policy";
import { UnionFind } from "@/lib/util/unionfind";
import type { Customer, DetectionContext } from "./context";
import { sameHousehold } from "./fd02-device";
import { emptyEntities, type Finding, type Ref, type Rule } from "./types";

const D = 86400000;
const custRef = (c: Customer): Ref => ({ table: "customers", id: c.customer_id });

/** Attributes that should be unique to one person: identity number, phone, email. */
function keysOf(c: Customer): [string, string][] {
  const out: [string, string][] = [];
  if (c.national_id) out.push(["national_id", c.national_id]);
  if (c.phone_norm) out.push(["phone", c.phone_norm]);
  if (c.email_norm) out.push(["email", c.email_norm]);
  return out;
}

function implausible(c: Customer): string | null {
  if (!c.dob) return null;
  const dob = Date.parse(c.dob);
  if (isNaN(dob)) return null;
  const age = (c.onboarded - dob) / (365.25 * D);
  if (age < 0) return `date of birth ${c.dob} is after onboarding`;
  if (age < 18) return `aged ${Math.floor(age)} at onboarding`;
  if (age > 100) return `aged ${Math.floor(age)} at onboarding`;
  return null;
}

/**
 * FD-04: profiles that are supposed to be independent but share identity attributes.
 * Catches synthetic identities (one ID number, several names) and profile farms (one phone or email, many customers).
 */
export function detectIdentityLinks(ctx: DetectionContext): Finding[] {
  const p = ctx.policy.fd04.params;
  const S = ctx.policy.fd04.signals;
  const M = ctx.policy.fd04.mitigations;
  const byKey = new Map<string, Customer[]>();
  for (const c of ctx.customers.values()) {
    for (const [kind, value] of keysOf(c)) {
      const k = `${kind}:${value}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(c);
    }
  }
  const uf = new UnionFind<string>();
  const shared: { kind: string; value: string; members: Customer[] }[] = [];
  for (const [k, members] of byKey) {
    if (members.length < 2 || members.length > ctx.policy.hubDegree) continue;
    const [kind, ...rest] = k.split(":");
    shared.push({ kind, value: rest.join(":"), members });
    for (let i = 1; i < members.length; i++) uf.union(members[0].customer_id, members[i].customer_id);
  }

  const findings: Finding[] = [];
  for (const ids of uf.groups()) {
    if (ids.length < 2) continue;
    const members = ids.map((id) => ctx.customers.get(id)!).sort((a, b) => a.onboarded - b.onboarded);
    const inGroup = new Set(ids);
    const links = shared.filter((s) => s.members.every((m) => inGroup.has(m.customer_id)));
    const signals: Rule[] = [];
    const mitigations: Rule[] = [];
    const add = (list: Rule[], code: string, defs: Record<string, { weight: number; label: string }>, detail: string, evidence: Ref[]) =>
      list.push({ code, label: defs[code].label, weight: defs[code].weight, detail, evidence });

    const idReuse = links.filter((l) => l.kind === "national_id" && (new Set(l.members.map((m) => m.name_norm)).size > 1 || new Set(l.members.map((m) => m.dob)).size > 1));
    if (idReuse.length) add(signals, "ID_REUSE", S, idReuse.map((l) => `National ID ${l.value} is used by ${l.members.map((m) => `${m.full_name} (${m.customer_id}, born ${m.dob ?? "?"})`).join(" and ")}`).join("; "), idReuse.flatMap((l) => l.members.map(custRef)));
    const contacts = links.filter((l) => l.kind !== "national_id");
    if (contacts.length) add(signals, "SHARED_CONTACT", S, contacts.map((l) => `${l.kind} ${l.value} is on ${l.members.length} profiles: ${l.members.map((m) => m.customer_id).join(", ")}`).join("; "), contacts.flatMap((l) => l.members.map(custRef)));
    const dobs = new Set(members.map((m) => m.dob).filter(Boolean));
    if (dobs.size === 1 && new Set(members.map((m) => m.name_norm)).size === members.length) add(signals, "SAME_DOB_DIFFERENT_NAME", S, `All ${members.length} profiles give date of birth ${[...dobs][0]} under different names`, members.map(custRef));
    const span = members[members.length - 1].onboarded - members[0].onboarded;
    if (span <= p.clusterOnboardingDays * D) add(signals, "CLUSTERED_ONBOARDING", S, `Onboarded within ${Math.max(1, Math.round(span / D))} day(s): ${members.map((m) => m.onboarding_date.slice(0, 10)).join(", ")}`, members.map(custRef));
    const surnames = new Set(members.map((m) => m.surname).filter(Boolean));
    const addresses = new Set(members.map((m) => m.address_norm).filter(Boolean));
    if (surnames.size === members.length && addresses.size === members.length) add(signals, "UNRELATED_IDENTITIES", S, "No two linked profiles share a surname or address", members.map(custRef));
    const odd = members.map((m) => [m, implausible(m)] as const).filter(([, why]) => why);
    if (odd.length) add(signals, "IMPLAUSIBLE_ATTRIBUTES", S, odd.map(([m, why]) => `${m.customer_id}: ${why}`).join("; "), odd.map(([m]) => custRef(m)));

    const raw = signals.reduce((s, r) => s + r.weight, 0);
    if (raw < ctx.policy.recordThreshold) continue;
    const household = sameHousehold(members);
    if (household && idReuse.length === 0) add(mitigations, "SAME_HOUSEHOLD", M, "Linked profiles share a household (address, or surname and city)", members.map(custRef));

    const entities = emptyEntities();
    ids.forEach((id) => entities.customers.add(id));
    const evidence = members.map(custRef);
    findings.push({
      detector: "FD-04",
      category: DETECTORS["FD-04"],
      title: `${members.length} profiles share ${[...new Set(links.map((l) => l.kind.replace("_", " ")))].join(", ")}`,
      subject_type: "customer",
      subject_id: members[members.length - 1].customer_id,
      primary_ref: custRef(members[members.length - 1]),
      event_time: new Date(members[members.length - 1].onboarded).toISOString(),
      signals,
      mitigations,
      evidence,
      entities,
      products: new Set(ids.flatMap((id) => (ctx.accountsByCustomer.get(id) ?? []).map((a) => a.product)).concat(["banking"]).slice(0, 4)),
      floor: idReuse.length ? { min: ctx.policy.floors.idReuse, note: "One national ID number cannot belong to different people" } : undefined,
    });
  }
  return findings;
}
