import { all } from "@/lib/db/client";
import { loadContext } from "@/lib/detect/context";
import type { Ref } from "@/lib/detect/types";
import type { Level } from "@/lib/policy";
import { resolveRefs, type AlertRow } from "@/lib/queries";
import { graphScoresFor } from "@/lib/ml/query";

/**
 * Relationship graph of one case. Every edge is derived from rows in the imported source tables and carries the
 * IDs of the rows that created it; nothing is inferred or invented. Hubs (kiosks, merchants, pools) are flagged and
 * never expanded.
 */
export type NodeType = "customer" | "account" | "external_account" | "device" | "ip" | "phone" | "email" | "national_id" | "loan_application" | "claim" | "policy" | "provider" | "document";
export type System = "banking" | "lending" | "insurance" | "digital" | "identity";
export type GraphNode = {
  id: string; type: NodeType; label: string; detail: string; systems: System[]; risk: Level | null; suspicious: boolean; hub: boolean; bridge: boolean;
  refs: Ref[]; alerts: string[]; first: string | null; last: string | null; model_score?: number; model_drivers?: string[];
};
export type GraphEdge = {
  id: string; source: string; target: string; type: string; label: string; system: System; evidence: Ref[]; evidence_count: number;
  first: string | null; last: string | null; amount: number | null; suspicious: boolean; alerts: string[]; why: string;
};
export type CaseGraph = { nodes: GraphNode[]; edges: GraphEdge[]; records: Record<string, Record<string, unknown>>; truncated: boolean };

const RANK: Record<Level, number> = { Low: 1, Medium: 2, High: 3 };
const EVIDENCE_CAP = 25;
const MAX_NODES = 160;
const k = (r: Ref) => `${r.table}:${r.id}`;
const marks = (xs: unknown[]) => xs.map(() => "?").join(",");
type Row = Record<string, unknown>;

const nodeIdsOf = (nodes: Map<string, GraphNode>, type: NodeType) => [...nodes.values()].filter((n) => n.type === type).map((n) => n.id.split(":").slice(1).join(":"));

export async function buildCaseGraph(alerts: AlertRow[]): Promise<CaseGraph> {
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const set = (key: "customer_ids" | "account_ids" | "device_ids" | "application_ids" | "claim_ids" | "transaction_ids") => [...new Set(members.flatMap((a) => a[key]))];
  const customerIds = set("customer_ids");
  const accountIds = set("account_ids");
  const deviceIds = set("device_ids");
  const appIds = set("application_ids");
  const claimIds = set("claim_ids");
  const evidence = new Set(members.flatMap((a) => [a.primary_ref, ...a.evidence]).map(k));
  const evidenceOf = (table: Ref["table"]) => [...evidence].filter((e) => e.startsWith(`${table}:`)).map((e) => e.slice(table.length + 1));
  const txnIds = [...new Set([...set("transaction_ids"), ...evidenceOf("transactions")])];
  const loginIds = evidenceOf("login_events");

  const ctx = await loadContext();
  const customers = customerIds.length ? await all<Row>(`SELECT * FROM customers WHERE customer_id IN (${marks(customerIds)})`, customerIds) : [];
  const accounts = await all<Row>(`SELECT * FROM accounts WHERE ${[
    customerIds.length ? `customer_id IN (${marks(customerIds)})` : "0", accountIds.length ? `account_id IN (${marks(accountIds)})` : "0"].join(" OR ")}`, [...customerIds, ...accountIds]);
  const accountSet = new Set([...accountIds, ...accounts.map((a) => String(a.account_id))]);
  const txns = await all<Row>(`SELECT * FROM transactions WHERE ${[
    txnIds.length ? `transaction_id IN (${marks(txnIds)})` : "0",
    accountSet.size ? `account_id IN (${marks([...accountSet])}) OR beneficiary_account IN (${marks([...accountSet])})` : "0"].join(" OR ")} ORDER BY timestamp LIMIT 400`,
    [...txnIds, ...accountSet, ...accountSet]);
  const logins = customerIds.length ? await all<Row>(`SELECT * FROM login_events WHERE ${[
    loginIds.length ? `event_id IN (${marks(loginIds)})` : "0",
    deviceIds.length ? `(device_id IN (${marks(deviceIds)}) AND customer_id IN (${marks(customerIds)}))` : "0"].join(" OR ")} ORDER BY timestamp LIMIT 400`,
    [...loginIds, ...deviceIds, ...customerIds]) : [];
  const loans = appIds.length ? await all<Row>(`SELECT * FROM loan_applications WHERE application_id IN (${marks(appIds)})`, appIds) : [];
  const claims = claimIds.length ? await all<Row>(`SELECT * FROM insurance_claims WHERE claim_id IN (${marks(claimIds)})`, claimIds) : [];

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (id: string, type: NodeType, label: string, detail: string, ref?: Ref, when?: string | null): GraphNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, type, label, detail, systems: [], risk: null, suspicious: false, hub: false, bridge: false, refs: [], alerts: [], first: null, last: null };
      nodes.set(id, n);
    }
    if (ref && !n.refs.some((r) => k(r) === k(ref))) n.refs.push(ref);
    if (when) {
      if (!n.first || when < n.first) n.first = when;
      if (!n.last || when > n.last) n.last = when;
    }
    return n;
  };
  const edge = (source: string, target: string, type: string, label: string, system: System, ref: Ref, when: string | null, why: string, amount?: number) => {
    const id = `${type}|${source}|${target}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, source, target, type, label, system, evidence: [], evidence_count: 0, first: null, last: null, amount: null, suspicious: false, alerts: [], why };
      edges.set(id, e);
    }
    e.evidence_count++;
    if (e.evidence.length < EVIDENCE_CAP) e.evidence.push(ref);
    if (amount !== undefined) e.amount = (e.amount ?? 0) + amount;
    if (when) {
      if (!e.first || when < e.first) e.first = when;
      if (!e.last || when > e.last) e.last = when;
    }
  };

  const nameOf = new Map(customers.map((c) => [String(c.customer_id), String(c.full_name)]));
  for (const c of customers) node(`cust:${c.customer_id}`, "customer", String(c.full_name), `${c.customer_id}${c.city ? ` · ${c.city}` : ""}`, { table: "customers", id: String(c.customer_id) }, c.onboarding_date as string | null);
  for (const a of accounts) {
    const own = String(a.customer_id);
    if (!nodes.has(`cust:${own}`) && !customerIds.includes(own)) continue;
    const ref: Ref = { table: "accounts", id: String(a.account_id) };
    node(`acct:${a.account_id}`, "account", String(a.account_id), `${a.product} account${a.account_type ? ` (${a.account_type})` : ""} of ${nameOf.get(own) ?? own}`, ref, a.opened_at as string | null);
    edge(`cust:${own}`, `acct:${a.account_id}`, "OWNS", "owns", "banking", ref, a.opened_at as string | null, `accounts.customer_id = ${own}`);
  }
  const accNode = (id: string) => {
    if (accounts.some((a) => a.account_id === id)) return node(`acct:${id}`, "account", id, "account");
    return node(`acct:${id}`, "external_account", id, "account outside the imported customer base (beneficiary or pool)");
  };
  for (const t of txns) {
    const ref: Ref = { table: "transactions", id: String(t.transaction_id) };
    const from = String(t.account_id);
    const to = String(t.beneficiary_account);
    accNode(from); accNode(to);
    const disb = t.type === "disbursement";
    edge(`acct:${from}`, `acct:${to}`, disb ? "DISBURSEMENT" : "TRANSFER", disb ? "loan disbursement" : "transfer", disb ? "lending" : "banking", ref, t.timestamp as string, `transactions.account_id → beneficiary_account`, Number(t.amount_inr ?? t.amount));
  }
  for (const l of logins) {
    const ref: Ref = { table: "login_events", id: String(l.event_id) };
    const cust = String(l.customer_id);
    if (!nodes.has(`cust:${cust}`)) continue;
    if (l.device_id) {
      node(`dev:${l.device_id}`, "device", String(l.device_id), "device seen in digital-channel events", undefined, l.timestamp as string);
      edge(`cust:${cust}`, `dev:${l.device_id}`, "LOGIN_FROM", "digital event from", "digital", ref, l.timestamp as string, "login_events.device_id");
    }
    if (l.ip_address) {
      node(`ip:${l.ip_address}`, "ip", String(l.ip_address), `${l.geo ?? "location unknown"}`, undefined, l.timestamp as string);
      edge(`cust:${cust}`, `ip:${l.ip_address}`, "USES_IP", "from IP", "digital", ref, l.timestamp as string, "login_events.ip_address");
    }
  }
  for (const a of loans) {
    const id = String(a.application_id);
    const ref: Ref = { table: "loan_applications", id };
    node(`app:${id}`, "loan_application", id, `₹${Number(a.requested_amount).toLocaleString("en-IN")} requested`, ref, a.submitted_at as string);
    edge(`cust:${a.customer_id}`, `app:${id}`, "APPLIED", "applied", "lending", ref, a.submitted_at as string, "loan_applications.customer_id");
    accNode(String(a.payout_account));
    edge(`app:${id}`, `acct:${a.payout_account}`, "PAYOUT_TO", "payout to", "lending", ref, a.submitted_at as string, "loan_applications.payout_account");
    if (a.device_id) {
      node(`dev:${a.device_id}`, "device", String(a.device_id), "device seen in digital-channel events");
      edge(`app:${id}`, `dev:${a.device_id}`, "SUBMITTED_FROM", "submitted from", "lending", ref, a.submitted_at as string, "loan_applications.device_id");
    }
  }
  for (const c of claims) {
    const id = String(c.claim_id);
    const ref: Ref = { table: "insurance_claims", id };
    const when = c.submitted_at as string;
    node(`clm:${id}`, "claim", id, `₹${Number(c.claim_amount).toLocaleString("en-IN")} ${c.claim_type ?? ""} claim`, ref, when);
    edge(`cust:${c.customer_id}`, `clm:${id}`, "CLAIMED", "claimed", "insurance", ref, when, "insurance_claims.customer_id");
    accNode(String(c.payout_account));
    edge(`clm:${id}`, `acct:${c.payout_account}`, "PAYOUT_TO", "payout to", "insurance", ref, when, "insurance_claims.payout_account");
    node(`pol:${c.policy_id}`, "policy", String(c.policy_id), `policy started ${String(c.policy_start_date ?? "unknown").slice(0, 10)}`);
    edge(`clm:${id}`, `pol:${c.policy_id}`, "UNDER_POLICY", "under policy", "insurance", ref, when, "insurance_claims.policy_id");
    if (c.provider_id) {
      node(`prov:${c.provider_id}`, "provider", String(c.provider_id), "repairer / provider");
      edge(`clm:${id}`, `prov:${c.provider_id}`, "AT_PROVIDER", "at provider", "insurance", ref, when, "insurance_claims.provider_id");
    }
    if (c.document_hash) {
      node(`doc:${c.document_hash}`, "document", String(c.document_hash).slice(0, 12), "invoice document fingerprint");
      edge(`clm:${id}`, `doc:${c.document_hash}`, "INVOICE", "supported by invoice", "insurance", ref, when, "insurance_claims.document_hash");
    }
    if (c.device_id) {
      node(`dev:${c.device_id}`, "device", String(c.device_id), "device seen in digital-channel events");
      edge(`clm:${id}`, `dev:${c.device_id}`, "SUBMITTED_FROM", "submitted from", "insurance", ref, when, "insurance_claims.device_id");
    }
  }
  // Shared identity attributes: only where two or more customers in the case hold the same normalised value.
  for (const [field, type, prefix] of [["phone_norm", "phone", "phone"], ["email_norm", "email", "email"], ["national_id", "national_id", "nid"]] as const) {
    const byValue = new Map<string, Row[]>();
    for (const c of customers) if (c[field]) byValue.set(String(c[field]), [...(byValue.get(String(c[field])) ?? []), c]);
    for (const [value, group] of byValue) {
      if (group.length < 2) continue;
      node(`${prefix}:${value}`, type, value, `shared by ${group.length} customers`);
      for (const c of group) edge(`cust:${c.customer_id}`, `${prefix}:${value}`, `SHARES_${type.toUpperCase()}`, `has ${type.replace("_", " ")}`, "identity", { table: "customers", id: String(c.customer_id) }, c.onboarding_date as string | null, `customers.${field} equal`);
    }
  }

  // Annotate: alerts, risk, suspicious paths, hubs, bridges.
  const entityOf = (n: GraphNode) => n.id.split(":").slice(1).join(":");
  for (const n of nodes.values()) {
    const id = entityOf(n);
    const related = members.filter((a) =>
      (n.type === "customer" && a.customer_ids.includes(id)) || ((n.type === "account" || n.type === "external_account") && a.account_ids.includes(id)) ||
      (n.type === "device" && a.device_ids.includes(id)) || (n.type === "loan_application" && a.application_ids.includes(id)) || (n.type === "claim" && a.claim_ids.includes(id)));
    n.alerts = related.map((a) => a.alert_id);
    n.suspicious = related.length > 0;
    n.risk = related.reduce<Level | null>((m, a) => (!m || RANK[a.level] > RANK[m] ? a.level : m), null);
    n.hub = (n.type === "device" && ctx.isHubDevice(id)) || ((n.type === "account" || n.type === "external_account") && ctx.isHubAccount(id));
  }
  for (const e of edges.values()) {
    e.alerts = members.filter((a) => e.evidence.some((r) => a.primary_ref.table === r.table && a.primary_ref.id === r.id || a.evidence.some((x) => k(x) === k(r)))).map((a) => a.alert_id);
    e.suspicious = e.alerts.length > 0;
    for (const end of [e.source, e.target]) {
      const n = nodes.get(end)!;
      if (!n.systems.includes(e.system)) n.systems.push(e.system);
    }
  }
  for (const n of nodes.values()) n.bridge = !n.hub && n.systems.filter((s) => s !== "identity").length >= 2 && (n.type === "account" || n.type === "external_account" || n.type === "device");

  const gs = await graphScoresFor(nodeIdsOf(nodes, "customer"));
  for (const n of nodes.values()) if (n.type === "customer") { const g = gs.get(entityOf(n)); n.model_score = g?.score ?? 0; n.model_drivers = g?.drivers ?? []; }

  let truncated = false;
  let nodeList = [...nodes.values()];
  if (nodeList.length > MAX_NODES) {
    truncated = true;
    nodeList = nodeList.sort((a, b) => Number(b.suspicious) - Number(a.suspicious)).slice(0, MAX_NODES);
  }
  const keep = new Set(nodeList.map((n) => n.id));
  const edgeList = [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target));
  const refs = [...new Map([...nodeList.flatMap((n) => n.refs), ...edgeList.flatMap((e) => e.evidence)].map((r) => [k(r), r])).values()];
  const rows = await resolveRefs(refs);
  const records: Record<string, Row> = {};
  for (const [key, row] of rows) records[key] = row;
  return { nodes: nodeList, edges: edgeList, records, truncated };
}
