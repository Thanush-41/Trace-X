import { DETECTORS } from "@/lib/policy";
import { UnionFind } from "@/lib/util/unionfind";
import type { DetectionContext } from "./context";
import { scoreFinding } from "./score";
import { emptyEntities, uniqueRefs, type Finding, type Rule, type ScoredFinding } from "./types";

/** Linkable entity keys of a finding, without hubs (merchants, kiosks) that would join unrelated cases. */
/** Link kinds that join alerts only when they happened within the policy's correlation window. */
const TIMED = ["phone:", "ip:", "pol:", "doc:"];
const MAX_SHARED_IP_CUSTOMERS = 5;

/** Phone, IP, policy and invoice-document links; each comes from a matching value in the imported source records. */
export function sourceKeys(ctx: DetectionContext, f: ScoredFinding): string[] {
  const keys: string[] = [];
  for (const c of f.entities.customers) {
    const phone = ctx.customers.get(c)?.phone_norm;
    const d = phone ? ctx.phoneDegree.get(phone) ?? 0 : 0;
    if (phone && d >= 2 && d <= ctx.policy.hubDegree) keys.push(`phone:${phone}`);
  }
  for (const r of f.evidence) {
    if (r.table === "login_events") {
      const ip = ctx.loginById.get(r.id)?.ip_address;
      const d = ip ? ctx.ipDegree.get(ip) ?? 0 : 0;
      if (ip && d >= 2 && d <= MAX_SHARED_IP_CUSTOMERS) keys.push(`ip:${ip}`);
    }
  }
  for (const id of f.entities.claims) {
    const c = ctx.claimById.get(id);
    if (c) {
      keys.push(`pol:${c.policy_id}`);
      if (c.document_hash) keys.push(`doc:${c.document_hash}`);
    }
  }
  return [...new Set(keys)];
}

export function entityKeys(ctx: DetectionContext, f: ScoredFinding): string[] {
  const keys: string[] = [];
  f.entities.customers.forEach((c) => keys.push(`cust:${c}`));
  f.entities.accounts.forEach((a) => !ctx.isHubAccount(a) && keys.push(`acct:${a}`));
  f.entities.devices.forEach((d) => !ctx.isHubDevice(d) && keys.push(`dev:${d}`));
  f.entities.applications.forEach((a) => keys.push(`app:${a}`));
  f.entities.transactions.forEach((t) => keys.push(`txn:${t}`));
  f.entities.claims.forEach((c) => keys.push(`clm:${c}`));
  return [...keys, ...sourceKeys(ctx, f)];
}

export const describeKey = (k: string) => {
  const [kind, ...rest] = k.split(":");
  const label = { cust: "Customer", acct: "Account", dev: "Device", app: "Application", txn: "Transaction", clm: "Claim", phone: "Phone", ip: "IP address", pol: "Policy", doc: "Invoice document" }[kind] ?? kind;
  return `${label} ${rest.join(":")}`;
};

export type SplitConstraint = { id: number; from_case_id: string; to_case_id: string; moved: Set<string>; kept: Set<string> };
export type Group = { alerts: ScoredFinding[]; case_id?: string; case_key?: string };

/**
 * Groups Medium/High findings that share an entity. Each group becomes one case.
 * Phone, IP, policy and document links also require the two alerts to fall within the correlation window.
 */
export function correlate(ctx: DetectionContext, findings: ScoredFinding[], splits: SplitConstraint[] = []): Group[] {
  const uf = new UnionFind<number>();
  const owner = new Map<string, number[]>();
  const windowMs = ctx.policy.priority.correlationWindowDays * 86400000;
  const when = findings.map((f) => Date.parse(f.event_time));
  findings.forEach((f, i) => {
    uf.add(i);
    for (const k of entityKeys(ctx, f)) {
      const timed = TIMED.some((p) => k.startsWith(p));
      const seen = owner.get(k) ?? [];
      for (const j of seen) if (!timed || Math.abs(when[i] - when[j]) <= windowMs) uf.union(j, i);
      seen.push(i);
      owner.set(k, seen);
    }
  });
  const groups: Group[] = uf.groups().map((idx) => ({ alerts: idx.sort((a, b) => a - b).map((i) => findings[i]) }));
  return applySplits(groups, splits);
}

const bare = (alerts: ScoredFinding[]) => alerts.filter((a) => a.detector !== "FD-06").map((a) => a.fingerprint);

/** Analyst corrections: alerts an analyst separated stay separate when detection groups them again. */
export function applySplits(groups: Group[], splits: SplitConstraint[]): Group[] {
  let out = groups;
  for (const s of splits) {
    out = out.flatMap((g) => {
      const fps = new Set(bare(g.alerts));
      const hasMoved = [...s.moved].some((f) => fps.has(f));
      const hasOther = [...fps].some((f) => !s.moved.has(f));
      if (!hasMoved || !hasOther) return [g];
      const moved = g.alerts.filter((a) => s.moved.has(a.fingerprint));
      const rest = g.alerts.filter((a) => !s.moved.has(a.fingerprint));
      return [{ alerts: rest }, { alerts: moved }];
    });
  }
  // Re-attach the case IDs the analyst already created, so a re-run updates them instead of duplicating.
  for (const g of out) {
    const fps = new Set(bare(g.alerts));
    for (const s of splits) {
      const same = (set: Set<string>) => set.size === fps.size && [...set].every((f) => fps.has(f));
      if (same(s.moved)) { g.case_id = s.to_case_id; g.case_key = `split:${s.id}`; }
      else if (same(s.kept)) { g.case_id = s.from_case_id; g.case_key = `split-rest:${s.id}`; }
    }
  }
  return out;
}

/**
 * FD-06: a group spanning several detectors and several customers or products is organised,
 * cross-system activity. Its score starts from the strongest member and grows with breadth.
 */
export function crossSystemFinding(ctx: DetectionContext, group: ScoredFinding[]): ScoredFinding | null {
  const detectors = [...new Set(group.map((f) => f.detector))].sort();
  const customers = new Set(group.flatMap((f) => [...f.entities.customers]));
  const products = new Set(group.flatMap((f) => [...f.products]));
  if (detectors.length < 2 || (customers.size < 2 && products.size < 2)) return null;

  const p = ctx.policy.fd06.params;
  const strongest = group.reduce((a, b) => (b.score > a.score ? b : a));
  const memberRefs = uniqueRefs(group.map((f) => f.primary_ref));
  const signals: Rule[] = [
    { code: "STRONGEST_MEMBER", label: "Strongest linked alert", weight: strongest.score, detail: `${strongest.category} (${strongest.detector}) scored ${strongest.score}: ${strongest.title}`, evidence: [strongest.primary_ref] },
    { code: "MULTIPLE_DETECTORS", label: "Independent detectors agree", weight: p.perExtraDetector * (detectors.length - 1), detail: detectors.map((d) => `${d} ${DETECTORS[d as keyof typeof DETECTORS]}`).join(", "), evidence: memberRefs },
  ];
  if (products.size >= 2) signals.push({ code: "MULTIPLE_PRODUCTS", label: "Spans several product systems", weight: p.multiProductBonus, detail: [...products].sort().join(", "), evidence: memberRefs });

  // Entities that appear in alerts from different detectors are the bridges an investigator should look at first.
  const keyDetectors = new Map<string, Set<string>>();
  for (const f of group) for (const k of entityKeys(ctx, f)) {
    if (!keyDetectors.has(k)) keyDetectors.set(k, new Set());
    keyDetectors.get(k)!.add(f.detector);
  }
  const bridges = [...keyDetectors].filter(([k, d]) => d.size >= 2 && !k.startsWith("txn:"));
  if (bridges.length) {
    const bridgeRefs = uniqueRefs(bridges.flatMap(([key]) => group.filter((f) => entityKeys(ctx, f).includes(key)).map((f) => f.primary_ref)));
    signals.push({
      code: "BRIDGING_ENTITIES",
      label: "Shared entities connecting the alerts",
      weight: 0,
      detail: bridges.slice(0, 8).map(([k, d]) => `${describeKey(k)} links ${[...d].sort().join(" + ")}`).join("; "),
      evidence: bridgeRefs,
    });
  }

  const entities = emptyEntities();
  for (const f of group) for (const key of Object.keys(entities) as (keyof typeof entities)[]) f.entities[key].forEach((v) => entities[key].add(v));
  const latest = group.reduce((a, b) => (b.event_time > a.event_time ? b : a));

  const finding: Finding = {
    detector: "FD-06",
    category: DETECTORS["FD-06"],
    title: `${group.length} linked alerts across ${detectors.length} detectors, ${customers.size} customers`,
    subject_type: "network",
    subject_id: strongest.subject_id,
    primary_ref: latest.primary_ref,
    event_time: latest.event_time,
    signals,
    mitigations: [],
    evidence: uniqueRefs(group.flatMap((f) => f.evidence)),
    entities,
    products,
    members: group.map((f) => f.fingerprint),
  };
  return scoreFinding(finding, ctx.policy);
}
