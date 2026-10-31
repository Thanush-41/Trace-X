import type { DetectionContext } from "@/lib/detect/context";

/**
 * Per-customer node features for the graph model. Everything comes from the imported records; no rule-detector output
 * and no labels are used. One feature is the isolation-forest percentile, so the model is independent of the rules
 * but not of the transfer anomaly model.
 */
export const NODE_FEATURES = [
  "days since onboarding (log)", "youngest account age (log)", "number of accounts", "distinct devices (log)", "failed-login share",
  "recent SIM swap", "remote-access tool seen", "emulator / rooted device seen", "VPN / proxy share", "max behaviour anomaly",
  "outgoing amount (log)", "largest transfer vs own median (log)", "distinct beneficiaries (log)", "payee-name mismatch share",
  "max isolation-forest percentile", "outflow vs 7-day inflow (max)", "loan applications (log)", "loan amount vs declared income",
  "insurance claims", "claim vs sum insured (max)", "claim soon after policy start", "max device sharing (log)",
  "max payout/beneficiary account sharing (log)", "phone shared with others", "declared income (log)", "no login history",
] as const;

const log1 = (x: number) => Math.log10(1 + Math.max(0, x));
const DAY = 86400000;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export type NodeTable = { ids: string[]; X: number[][] };

export function nodeFeatures(ctx: DetectionContext): NodeTable {
  const now = Math.max(0, ...[...ctx.outByAccount.values()].flat().map((t) => t.ts), ...[...ctx.loginsByCustomer.values()].flat().map((l) => l.ts));
  const ids = [...ctx.customers.keys()].sort();
  const payoutCustomers = new Map<string, Set<string>>();
  const touch = (k: string, c: string) => { if (!payoutCustomers.has(k)) payoutCustomers.set(k, new Set()); payoutCustomers.get(k)!.add(c); };
  for (const l of ctx.loans) touch(l.payout_account, l.customer_id);
  for (const c of ctx.claims) touch(c.payout_account, c.customer_id);
  for (const [b, s] of ctx.sendersByBeneficiary) for (const x of s) touch(b, x.customer);

  const X = ids.map((id) => {
    const c = ctx.customers.get(id)!;
    const accts = ctx.accountsByCustomer.get(id) ?? [];
    const logins = ctx.loginsByCustomer.get(id) ?? [];
    const out = accts.flatMap((a) => ctx.outByAccount.get(a.account_id) ?? []);
    const loans = ctx.loansByCustomer.get(id) ?? [];
    const claims = ctx.claimsByCustomer.get(id) ?? [];
    const devices = [...new Set(logins.map((l) => l.device_id).filter(Boolean) as string[])];
    const amounts = out.map((t) => t.amount);
    const med = median(amounts);
    let drain = 0;
    for (const a of accts) {
      const inflow = ctx.inByAccount.get(a.account_id) ?? [];
      for (const t of ctx.outByAccount.get(a.account_id) ?? []) {
        const inSum = inflow.filter((x) => x.ts <= t.ts && x.ts > t.ts - 7 * DAY).reduce((s, x) => s + x.amount, 0);
        if (inSum > 0) drain = Math.max(drain, Math.min(3, t.amount / inSum));
      }
    }
    const income = c.declared_income ?? 0;
    const phone = c.phone_norm ? ctx.phoneDegree.get(c.phone_norm) ?? 1 : 1;
    return [
      Number.isFinite(c.onboarded) ? log1((now - c.onboarded) / DAY) : 2,
      accts.length ? log1(Math.min(...accts.map((a) => (now - a.opened) / DAY))) : 2,
      Math.min(accts.length, 6) / 6,
      log1(devices.length),
      logins.length ? logins.filter((l) => l.outcome === "failure").length / logins.length : 0,
      logins.some((l) => l.sim_swap_days !== null && l.sim_swap_days <= 7) ? 1 : 0,
      logins.some((l) => l.remote_access === 1) ? 1 : 0,
      logins.some((l) => l.emulator_or_rooted === 1) ? 1 : 0,
      logins.length ? logins.filter((l) => l.vpn_proxy === 1).length / logins.length : 0,
      Math.max(0, ...logins.map((l) => l.typing_anomaly ?? 0)),
      log1(amounts.reduce((s, a) => s + a, 0)) / 7,
      med ? log1(Math.max(...amounts) / med) : 0,
      log1(new Set(out.map((t) => t.beneficiary_account)).size),
      out.length ? out.filter((t) => t.payee_name_check === "no_match" || t.payee_name_check === "partial").length / out.length : 0,
      Math.max(0, ...out.map((t) => ctx.anomaly.get(t.transaction_id)?.percentile ?? 0)) / 100,
      drain / 3,
      log1(loans.length),
      Math.min(10, Math.max(0, ...loans.map((l) => (l.declared_income ? l.requested_amount / l.declared_income : 0)))) / 10,
      Math.min(claims.length, 5) / 5,
      Math.max(0, ...claims.map((x) => (x.sum_insured ? x.claim_amount / x.sum_insured : 0))),
      claims.some((x) => x.policy_start_date && x.incident - Date.parse(x.policy_start_date) < 30 * DAY) ? 1 : 0,
      log1(Math.max(0, ...devices.map((d) => (ctx.deviceDegree.get(d) ?? 1) - 1))),
      log1(Math.max(0, ...[...payoutCustomers].filter(([, s]) => s.has(id)).map(([, s]) => s.size - 1))),
      Math.min(phone - 1, 5) / 5,
      log1(income) / 7,
      logins.length ? 0 : 1,
    ];
  });
  return { ids, X };
}

/**
 * Customer graph: an edge for each shared device, phone, email, national ID, payout / beneficiary account or invoice
 * document. Hubs (more customers than the policy's hub limit) are left out, like in correlation.
 */
export function customerGraph(ctx: DetectionContext, ids: string[]): { edges: [number, number, number][]; reasons: Map<string, string[]> } {
  const index = new Map(ids.map((id, i) => [id, i]));
  const groups = new Map<string, Set<string>>();
  const put = (k: string, c: string) => { if (!groups.has(k)) groups.set(k, new Set()); groups.get(k)!.add(c); };
  for (const [d, ls] of ctx.loginsByDevice) for (const l of ls) put(`device ${d}`, l.customer_id);
  for (const l of ctx.loans) { if (l.device_id) put(`device ${l.device_id}`, l.customer_id); put(`payout account ${l.payout_account}`, l.customer_id); }
  for (const c of ctx.claims) { put(`payout account ${c.payout_account}`, c.customer_id); if (c.document_hash) put(`invoice ${c.document_hash.slice(0, 10)}`, c.customer_id); if (c.device_id) put(`device ${c.device_id}`, c.customer_id); }
  for (const a of ctx.accounts.values()) put(`payout account ${a.account_id}`, a.customer_id);
  for (const [b, s] of ctx.sendersByBeneficiary) if (!ctx.accounts.has(b)) for (const x of s) put(`beneficiary ${b}`, x.customer);
  for (const c of ctx.customers.values()) {
    if (c.phone_norm) put(`phone ${c.phone_norm}`, c.customer_id);
    if (c.email_norm) put(`email ${c.email_norm}`, c.customer_id);
    if (c.national_id) put(`national ID ${c.national_id}`, c.customer_id);
  }
  const weight = new Map<string, number>();
  const reasons = new Map<string, string[]>();
  for (const [k, set] of groups) {
    if (set.size < 2 || set.size > ctx.policy.hubDegree) continue;
    const members = [...set].filter((c) => index.has(c));
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const [a, b] = [members[i], members[j]].sort();
      const key = `${a}|${b}`;
      weight.set(key, (weight.get(key) ?? 0) + 1 / Math.log2(1 + set.size));
      reasons.set(key, [...(reasons.get(key) ?? []), k]);
    }
  }
  const edges: [number, number, number][] = [...weight].map(([k, w]) => { const [a, b] = k.split("|"); return [index.get(a)!, index.get(b)!, w]; });
  return { edges, reasons };
}

/** Symmetric-normalised propagation Â·H with self-loops (Kipf & Welling). */
export function propagate(n: number, edges: [number, number, number][], H: number[][]): number[][] {
  const deg = new Array(n).fill(1);
  for (const [a, b, w] of edges) { deg[a] += w; deg[b] += w; }
  const out = H.map((row, i) => row.map((v) => v / deg[i]));
  for (const [a, b, w] of edges) {
    const s = w / Math.sqrt(deg[a] * deg[b]);
    for (let k = 0; k < H[a].length; k++) { out[a][k] += s * H[b][k]; out[b][k] += s * H[a][k]; }
  }
  return out;
}

/** SIGN-style graph features: own features, 1-hop and 2-hop propagated neighbourhood features. */
export function graphFeatures(n: number, edges: [number, number, number][], X: number[][]): number[][] {
  const h1 = propagate(n, edges, X);
  const h2 = propagate(n, edges, h1);
  return X.map((x, i) => [...x, ...h1[i], ...h2[i]]);
}
