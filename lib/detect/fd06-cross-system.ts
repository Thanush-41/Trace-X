import { DETECTORS } from "@/lib/policy";
import { UnionFind } from "@/lib/util/unionfind";
import type { DetectionContext } from "./context";
import { scoreFinding } from "./score";
import { emptyEntities, uniqueRefs, type Finding, type Rule, type ScoredFinding } from "./types";

/** Linkable entity keys of a finding, without hubs (merchants, kiosks) that would join unrelated cases. */
function entityKeys(ctx: DetectionContext, f: ScoredFinding): string[] {
  const keys: string[] = [];
  f.entities.customers.forEach((c) => keys.push(`cust:${c}`));
  f.entities.accounts.forEach((a) => !ctx.isHubAccount(a) && keys.push(`acct:${a}`));
  f.entities.devices.forEach((d) => !ctx.isHubDevice(d) && keys.push(`dev:${d}`));
  f.entities.applications.forEach((a) => keys.push(`app:${a}`));
  f.entities.transactions.forEach((t) => keys.push(`txn:${t}`));
  f.entities.claims.forEach((c) => keys.push(`clm:${c}`));
  return keys;
}

const describeKey = (k: string) => {
  const [kind, ...rest] = k.split(":");
  const label = { cust: "Customer", acct: "Account", dev: "Device", app: "Application", txn: "Transaction", clm: "Claim" }[kind] ?? kind;
  return `${label} ${rest.join(":")}`;
};

/** Groups Medium/High findings that share an entity. Each group becomes one case. */
export function correlate(ctx: DetectionContext, findings: ScoredFinding[]): ScoredFinding[][] {
  const uf = new UnionFind<number>();
  const owner = new Map<string, number>();
  findings.forEach((f, i) => {
    uf.add(i);
    for (const k of entityKeys(ctx, f)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else uf.union(j, i);
    }
  });
  return uf.groups().map((idx) => idx.sort((a, b) => a - b).map((i) => findings[i]));
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
