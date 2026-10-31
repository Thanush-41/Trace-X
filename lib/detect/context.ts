import { all } from "@/lib/db/client";
import { policy as defaultPolicy, type Policy } from "@/lib/policy";
import { sha256 } from "@/lib/util/hash";

export type Claim = {
  claim_id: string; policy_id: string; customer_id: string; claim_type: string; incident_date: string; incident: number; submitted_at: string; ts: number;
  claim_amount: number; sum_insured: number | null; policy_start_date: string | null; provider_id: string | null; payout_account: string;
  device_id: string | null; document_hash: string | null; status: string | null;
};
export type Customer = {
  customer_id: string; full_name: string; dob: string | null; national_id: string | null; phone_norm: string; email_norm: string;
  address_norm: string | null; city: string | null; surname: string; name_norm: string; onboarding_date: string; onboarded: number;
  declared_income: number | null;
};
export type Account = { account_id: string; customer_id: string; product: string; opened_at: string; opened: number };
export type Txn = {
  transaction_id: string; account_id: string; beneficiary_account: string; beneficiary_name: string | null; amount: number;
  timestamp: string; ts: number; channel: string; status: string; type: string; application_id: string | null;
};
export type Login = { event_id: string; customer_id: string; device_id: string | null; ip_address: string | null; geo: string | null; timestamp: string; ts: number; outcome: string; event_type: string };
export type Loan = {
  application_id: string; customer_id: string; device_id: string | null; phone_norm: string | null; email_norm: string | null;
  requested_amount: number; payout_account: string; submitted_at: string; ts: number; status: string | null; declared_income: number | null;
};

const group = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
};

/** Everything a detection run needs, loaded once and indexed in memory. */
export class DetectionContext {
  customers = new Map<string, Customer>();
  accounts = new Map<string, Account>();
  accountsByCustomer = new Map<string, Account[]>();
  outByAccount = new Map<string, Txn[]>();
  inByAccount = new Map<string, Txn[]>();
  sendersByBeneficiary = new Map<string, { ts: number; customer: string; transaction_id: string }[]>();
  loginsByCustomer = new Map<string, Login[]>();
  loginsByDevice = new Map<string, Login[]>();
  loans: Loan[] = [];
  loansByCustomer = new Map<string, Loan[]>();
  claims: Claim[] = [];
  claimsByCustomer = new Map<string, Claim[]>();
  /** Distinct customers attached to each account / device; high values mean hubs (merchants, kiosks). */
  accountDegree = new Map<string, number>();
  deviceDegree = new Map<string, number>();
  /** Isolation-forest scores per outgoing transaction, filled once per run. */
  anomaly = new Map<string, { score: number; percentile: number; drivers: string[] }>();
  inputHash = "";
  counts: Record<string, number> = {};

  constructor(public policy: Policy = defaultPolicy) {}

  ownerOf(account: string): string | undefined {
    return this.accounts.get(account)?.customer_id;
  }

  isHubAccount(account: string): boolean {
    return (this.accountDegree.get(account) ?? 0) > this.policy.hubDegree;
  }

  isHubDevice(device: string): boolean {
    return (this.deviceDegree.get(device) ?? 0) > this.policy.hubDegree;
  }
}

export async function loadContext(policy: Policy = defaultPolicy): Promise<DetectionContext> {
  const ctx = new DetectionContext(policy);
  const [customers, accounts, txns, logins, loans, claims] = await Promise.all([
    all<Omit<Customer, "onboarded"> & { row_hash: string }>("SELECT customer_id, full_name, dob, national_id, phone_norm, email_norm, address_norm, city, surname, name_norm, onboarding_date, declared_income, row_hash FROM customers ORDER BY customer_id"),
    all<Omit<Account, "opened"> & { row_hash: string }>("SELECT account_id, customer_id, product, opened_at, row_hash FROM accounts ORDER BY account_id"),
    all<Omit<Txn, "ts"> & { row_hash: string }>("SELECT transaction_id, account_id, beneficiary_account, beneficiary_name, COALESCE(amount_inr, amount) AS amount, timestamp, channel, status, type, application_id, row_hash FROM transactions ORDER BY timestamp, transaction_id"),
    all<Omit<Login, "ts"> & { row_hash: string }>("SELECT event_id, customer_id, device_id, ip_address, geo, timestamp, outcome, event_type, row_hash FROM login_events ORDER BY timestamp, event_id"),
    all<Omit<Loan, "ts"> & { row_hash: string }>("SELECT application_id, customer_id, device_id, phone_norm, email_norm, requested_amount, payout_account, submitted_at, status, declared_income, row_hash FROM loan_applications ORDER BY submitted_at, application_id"),
    all<Omit<Claim, "ts" | "incident"> & { row_hash: string }>("SELECT claim_id, policy_id, customer_id, claim_type, incident_date, submitted_at, claim_amount, sum_insured, policy_start_date, provider_id, payout_account, device_id, document_hash, status, row_hash FROM insurance_claims ORDER BY submitted_at, claim_id"),
  ]);

  const hash = [customers, accounts, txns, logins, loans, claims].map((rows) => rows.map((r) => r.row_hash).join("")).join("|");
  ctx.inputHash = sha256(hash + policy.version);
  ctx.counts = { customers: customers.length, accounts: accounts.length, transactions: txns.length, login_events: logins.length, loan_applications: loans.length, insurance_claims: claims.length };

  for (const c of customers) ctx.customers.set(c.customer_id, { ...c, declared_income: c.declared_income === null ? null : Number(c.declared_income), onboarded: Date.parse(c.onboarding_date) });
  for (const a of accounts) ctx.accounts.set(a.account_id, { ...a, opened: Date.parse(a.opened_at) });
  ctx.accountsByCustomer = group([...ctx.accounts.values()], (a) => a.customer_id);

  const parsedTxns: Txn[] = txns.map((t) => ({ ...t, amount: Number(t.amount), ts: Date.parse(t.timestamp) }));
  for (const t of parsedTxns) {
    // Reversed transfers never happened from the customer's point of view; they stay out of behaviour baselines.
    if (ctx.accounts.has(t.account_id) && t.type !== "deposit" && t.status !== "reversed") {
      if (!ctx.outByAccount.has(t.account_id)) ctx.outByAccount.set(t.account_id, []);
      ctx.outByAccount.get(t.account_id)!.push(t);
      const sender = ctx.ownerOf(t.account_id)!;
      if (!ctx.sendersByBeneficiary.has(t.beneficiary_account)) ctx.sendersByBeneficiary.set(t.beneficiary_account, []);
      ctx.sendersByBeneficiary.get(t.beneficiary_account)!.push({ ts: t.ts, customer: sender, transaction_id: t.transaction_id });
    }
    if (ctx.accounts.has(t.beneficiary_account)) {
      if (!ctx.inByAccount.has(t.beneficiary_account)) ctx.inByAccount.set(t.beneficiary_account, []);
      ctx.inByAccount.get(t.beneficiary_account)!.push(t);
    }
  }

  const parsedLogins: Login[] = logins.map((l) => ({ ...l, ts: Date.parse(l.timestamp) }));
  ctx.loginsByCustomer = group(parsedLogins, (l) => l.customer_id);
  // Events without a device never link customers through a shared "empty" device.
  ctx.loginsByDevice = group(parsedLogins.filter((l) => l.device_id), (l) => l.device_id as string);

  ctx.loans = loans.map((l) => ({ ...l, requested_amount: Number(l.requested_amount), declared_income: l.declared_income === null ? null : Number(l.declared_income), ts: Date.parse(l.submitted_at) }));
  ctx.loansByCustomer = group(ctx.loans, (l) => l.customer_id);
  ctx.claims = claims.map((c) => ({
    ...c, claim_amount: Number(c.claim_amount), sum_insured: c.sum_insured === null ? null : Number(c.sum_insured),
    ts: Date.parse(c.submitted_at), incident: Date.parse(c.incident_date),
  }));
  ctx.claimsByCustomer = group(ctx.claims, (c) => c.customer_id);

  // Degree = distinct customers touching an account (owner, senders, loan payouts) or a device.
  const accountCustomers = new Map<string, Set<string>>();
  const touch = (m: Map<string, Set<string>>, k: string, c: string) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(c);
  };
  for (const a of ctx.accounts.values()) touch(accountCustomers, a.account_id, a.customer_id);
  for (const [b, senders] of ctx.sendersByBeneficiary) for (const s of senders) touch(accountCustomers, b, s.customer);
  for (const l of ctx.loans) touch(accountCustomers, l.payout_account, l.customer_id);
  for (const c of ctx.claims) touch(accountCustomers, c.payout_account, c.customer_id);
  for (const [k, v] of accountCustomers) ctx.accountDegree.set(k, v.size);
  const deviceCustomers = new Map<string, Set<string>>();
  for (const l of parsedLogins) if (l.device_id) touch(deviceCustomers, l.device_id, l.customer_id);
  for (const l of ctx.loans) if (l.device_id) touch(deviceCustomers, l.device_id, l.customer_id);
  for (const c of ctx.claims) if (c.device_id) touch(deviceCustomers, c.device_id, c.customer_id);
  for (const [k, v] of deviceCustomers) ctx.deviceDegree.set(k, v.size);

  return ctx;
}
