/**
 * Seeded synthetic data for TRACE X.
 *
 *   npm run gen -- --seed 1 [--out data/samples/seed-1]
 *
 * Produces linked customers, accounts, transactions, login events and loan applications,
 * with planted fraud scenarios (S1–S6) and legitimate lookalikes (L1–L4) whose IDs, amounts
 * and times change with the seed. ground_truth.json describes what should (and should not)
 * be detected; the application never reads it during detection.
 */
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// ---------- deterministic randomness ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SEED = Number(argVal("seed") ?? 1);
const OUT = argVal("out") ?? path.join("data", "samples", `seed-${SEED}`);

const rand = mulberry32(SEED * 7919 + 17);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const shuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function gaussian() {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const lognormal = (median: number, sigma: number) => median * Math.exp(sigma * gaussian());
const round10 = (x: number) => Math.max(10, Math.round(x / 10) * 10);

const usedIds = new Set<string>();
function uid(prefix: string, digits = 8): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < digits; i++) s += int(0, 9);
    const id = `${prefix}${s}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}
function hexId(prefix: string): string {
  for (;;) {
    const id = `${prefix}${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0").toUpperCase()}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

// ---------- time ----------
const DAY = 86400000;
const MIN = 60000;
const WINDOW_START = Date.UTC(2026, 6, 1);
const WINDOW_END = Date.UTC(2026, 9, 15);
const PLANT_START = Date.UTC(2026, 9, 1);
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const isoDate = (t: number) => iso(t).slice(0, 10);
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a));
/** Daytime timestamp (08:00–21:00 UTC) on the day of t. */
const daytime = (t: number) => Math.floor(t / DAY) * DAY + int(8 * 60, 21 * 60) * MIN + int(0, 59) * 1000;

// ---------- reference data ----------
const FIRST = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan", "Kabir", "Ananya", "Diya", "Aadhya", "Saanvi", "Myra", "Anika", "Pari", "Navya", "Kiara", "Meera", "Riya", "Priya", "Sneha", "Kavya", "Rahul", "Vikram", "Suresh", "Ramesh", "Lakshmi", "Deepa", "Farhan", "Imran", "Zoya", "Ayesha", "Joseph", "Maria", "Thomas", "Harpreet", "Gurpreet", "Manoj", "Nikhil", "Pooja", "Divya", "Karthik", "Arun", "Bhavna", "Tanvi", "Yash", "Neha"];
const SURNAMES = ["Sharma", "Verma", "Iyer", "Reddy", "Nair", "Menon", "Gupta", "Patel", "Shah", "Mehta", "Rao", "Kulkarni", "Joshi", "Desai", "Pillai", "Banerjee", "Chatterjee", "Das", "Bose", "Singh", "Kaur", "Khan", "Qureshi", "Fernandes", "D'Souza", "Thomas", "George", "Agarwal", "Bansal", "Chopra", "Malhotra", "Kapoor", "Mishra", "Pandey", "Tiwari", "Yadav", "Naidu", "Hegde", "Shetty", "Kamath"];
const CITIES = ["Bengaluru", "Mumbai", "Chennai", "Hyderabad", "Pune", "Delhi", "Kolkata", "Kochi"];
const STREETS = ["MG Road", "Brigade Road", "Linking Road", "Anna Salai", "Banjara Hills Road 2", "FC Road", "Park Street", "Marine Drive", "Residency Road", "Church Street", "Hill Road", "Lake View Road", "Station Road", "Temple Street", "Gandhi Nagar Main Road"];
const CHANNELS = ["mobile", "netbanking", "upi"] as const;
const MERCHANTS = [
  ["MER-ELEC-001", "State Electricity Board"], ["MER-TEL-002", "Airtel Postpaid"], ["MER-TEL-003", "Jio Recharge"],
  ["MER-ECM-004", "Amazon Pay"], ["MER-ECM-005", "Flipkart"], ["MER-GRO-006", "BigBasket"],
  ["MER-FUE-007", "Indian Oil"], ["MER-INS-008", "LIC Premium"], ["MER-EDU-009", "School Fees Portal"], ["MER-OTT-010", "Netflix"],
] as const;
const LENDER_POOL = "LND-POOL-0001";
const OCCUPATIONS = ["salaried", "salaried", "salaried", "self-employed", "professional", "government", "student", "retired"];
const EMPLOYERS = ["Infosys", "TCS", "Wipro", "HDFC Bank", "State Govt", "Reliance Retail", "Apollo Hospitals", "L&T", "Self"];
const PURPOSES = ["home renovation", "education", "medical", "wedding", "vehicle", "debt consolidation", "business"];
const PROVIDERS: Record<string, string[]> = {
  health: ["HSP-APOLLO-01", "HSP-FORTIS-02", "HSP-MANIPAL-03", "HSP-MAX-04", "HSP-CITY-05"],
  motor: ["GAR-SPEEDFIX-01", "GAR-AUTOCARE-02", "GAR-MOTORHUB-03", "GAR-CITYGARAGE-04"],
  property: ["SVY-SURVEYOR-01", "SVY-SURVEYOR-02"],
};
const docHash = () => Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0") + Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0");

// ---------- record types ----------
type Customer = { customer_id: string; full_name: string; dob: string; national_id: string; phone: string; email: string; address: string; city: string; onboarding_date: string; onboarding_channel: string; kyc_status: string; occupation: string; declared_income: number };
type Account = { account_id: string; customer_id: string; product: string; account_type: string; opened_at: string; status: string };
type Txn = { transaction_id: string; account_id: string; beneficiary_account: string; beneficiary_name: string; amount: number; currency: string; timestamp: string; channel: string; status: string; type: string; application_id: string };
type Login = { event_id: string; customer_id: string; device_id: string; ip_address: string; geo: string; timestamp: string; outcome: string; event_type: string };
type Loan = { application_id: string; customer_id: string; device_id: string; phone: string; email: string; requested_amount: number; payout_account: string; submitted_at: string; status: string; declared_income: number; employer: string; loan_purpose: string };
type Claim = { claim_id: string; policy_id: string; customer_id: string; claim_type: string; incident_date: string; submitted_at: string; claim_amount: number; sum_insured: number; policy_start_date: string; provider_id: string; payout_account: string; device_id: string; document_hash: string; status: string; description: string };
type Entities = Partial<Record<"customer_ids" | "account_ids" | "transaction_ids" | "device_ids" | "application_ids" | "claim_ids", string[]>>;
type Truth =
  | { id: string; scenario: string; kind: "fraud"; detector: string; expected_level: "High" | "Medium"; entities: Entities; note: string }
  | { id: string; scenario: string; kind: "lookalike"; detector: string; max_level: "Low" | "None"; entities: Entities; note: string };

const customers: Customer[] = [];
const accounts: Account[] = [];
const txns: Txn[] = [];
const logins: Login[] = [];
const loans: Loan[] = [];
const truth: Truth[] = [];
const claims: Claim[] = [];

// ---------- builders ----------
type Person = {
  c: Customer;
  bank: Account;
  devices: string[];
  ips: string[];
  medianAmt: number;
  channels: [string, string];
  payees: { account: string; name: string }[];
};
const people: Person[] = [];
const usedPhones = new Set<string>();

function phone(): string {
  for (;;) {
    const p = `${pick(["9", "8", "7"])}${int(100000000, 999999999)}`;
    if (!usedPhones.has(p)) {
      usedPhones.add(p);
      return p;
    }
  }
}
function pan(): string {
  const L = () => String.fromCharCode(65 + int(0, 25));
  return `${L()}${L()}${L()}P${L()}${int(1000, 9999)}${L()}`;
}
function ip(): string {
  return `${pick([49, 103, 106, 117, 122, 157, 182, 203])}.${int(1, 254)}.${int(1, 254)}.${int(1, 254)}`;
}

function makePerson(opts: { onboarded: number; surname?: string; first?: string; address?: string; city?: string; medianAmt?: number; accountType?: string } ): Person {
  const first = opts.first ?? pick(FIRST);
  const surname = opts.surname ?? pick(SURNAMES);
  const city = opts.city ?? pick(CITIES);
  const c: Customer = {
    customer_id: uid("CUS", 6),
    full_name: `${first} ${surname}`,
    dob: isoDate(Date.UTC(int(1960, 2002), int(0, 11), int(1, 28))),
    national_id: pan(),
    phone: phone(),
    email: `${first.toLowerCase()}.${surname.toLowerCase().replace(/[^a-z]/g, "")}${int(1, 999)}@${pick(["gmail.com", "yahoo.co.in", "outlook.com", "rediffmail.com"])}`,
    address: opts.address ?? `${int(1, 400)}, ${pick(STREETS)}, ${city}`,
    city,
    onboarding_date: isoDate(opts.onboarded),
    onboarding_channel: pick(["branch", "mobile_app", "web"]),
    kyc_status: "verified",
    occupation: opts.accountType === "current" ? "business owner" : pick(OCCUPATIONS),
    declared_income: 0,
  };
  customers.push(c);
  const bank: Account = { account_id: uid("ACC", 10), customer_id: c.customer_id, product: "banking", account_type: opts.accountType ?? "savings", opened_at: isoDate(opts.onboarded), status: "active" };
  accounts.push(bank);
  const p: Person = {
    c, bank,
    devices: [hexId("DEV-")],
    ips: [ip()],
    medianAmt: opts.medianAmt ?? round10(lognormal(4000, 0.7)),
    channels: shuffle([...CHANNELS]).slice(0, 2) as [string, string],
    payees: [],
  };
  c.declared_income = Math.round((p.medianAmt * 6 * 12) / 1000) * 1000;
  if (chance(0.35)) p.devices.push(hexId("DEV-"));
  if (chance(0.3)) p.ips.push(ip());
  people.push(p);
  return p;
}

function addTxn(t: Omit<Txn, "transaction_id" | "currency" | "beneficiary_name" | "application_id" | "status" | "type"> & Partial<Txn>): Txn {
  const row: Txn = {
    transaction_id: uid("TXN", 10),
    currency: "INR",
    beneficiary_name: "",
    application_id: "",
    status: "completed",
    type: "transfer",
    ...t,
  };
  txns.push(row);
  return row;
}

function addLogin(l: Omit<Login, "event_id" | "event_type" | "outcome"> & Partial<Login>): Login {
  const row: Login = { event_id: uid("LGN", 10), outcome: "success", event_type: "login", ...l };
  logins.push(row);
  return row;
}

function addClaim(o: { policy: Account; type: string; sumInsured: number; incident: number; submitted: number; amount: number; payout: string; device: string; provider?: string; doc?: string; status?: string }): Claim {
  const row: Claim = {
    claim_id: uid("CLM", 8), policy_id: o.policy.account_id, customer_id: o.policy.customer_id, claim_type: o.type,
    incident_date: isoDate(o.incident), submitted_at: iso(o.submitted), claim_amount: o.amount, sum_insured: o.sumInsured,
    policy_start_date: o.policy.opened_at, provider_id: o.provider ?? pick(PROVIDERS[o.type]), payout_account: o.payout, device_id: o.device,
    document_hash: o.doc ?? docHash(), status: o.status ?? pick(["settled", "settled", "approved", "under_review"]),
    description: o.type === "health" ? "Hospitalisation" : o.type === "motor" ? "Vehicle damage" : "Property damage",
  };
  claims.push(row);
  return row;
}

/** Normal everyday behaviour for one person between two instants. */
function background(p: Person, from: number, to: number, nTransfers: number) {
  if (p.payees.length === 0) {
    const n = int(3, 5);
    for (let i = 0; i < n; i++) {
      const other = people.length > 20 && chance(0.4) ? pick(people.slice(0, BACKGROUND)) : undefined;
      if (other && other !== p) p.payees.push({ account: other.bank.account_id, name: other.c.full_name });
      else p.payees.push({ account: uid("EXT", 10), name: `${pick(FIRST)} ${pick(SURNAMES)}` });
    }
  }
  // Salary on the 1st of each month.
  for (let m = new Date(from); m.getTime() < to; m.setUTCMonth(m.getUTCMonth() + 1, 1)) {
    const t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1, 6, int(0, 59));
    if (t >= from && t < to) {
      addTxn({ account_id: `EMP-${p.c.customer_id}`, beneficiary_account: p.bank.account_id, beneficiary_name: p.c.full_name, amount: round10(p.medianAmt * int(4, 8)), timestamp: iso(t), channel: "neft", type: "deposit" });
    }
  }
  const times = Array.from({ length: nTransfers }, () => daytime(between(from, to))).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < 3 * 3600000) times[i] = times[i - 1] + 3 * 3600000;
  for (const t of times) {
    if (t >= to) continue;
    const device = pick(p.devices);
    addLogin({ customer_id: p.c.customer_id, device_id: device, ip_address: pick(p.ips), geo: p.c.city, timestamp: iso(t - int(2, 15) * MIN) });
    const merchant = chance(0.3);
    const payee = merchant ? (() => { const m = pick(MERCHANTS); return { account: m[0], name: m[1] }; })() : pick(p.payees);
    const r = rand();
    addTxn({
      account_id: p.bank.account_id,
      beneficiary_account: payee.account,
      beneficiary_name: payee.name,
      amount: round10(lognormal(merchant ? p.medianAmt * 0.4 : p.medianAmt, 0.5)),
      timestamp: iso(t),
      channel: chance(0.8) ? p.channels[0] : p.channels[1],
      status: r < 0.97 ? "completed" : r < 0.99 ? "failed" : "pending",
      type: merchant ? "payment" : "transfer",
    });
  }
  // Occasional idle logins, some with a single mistyped password.
  for (let i = 0, n = int(1, 4); i < n; i++) {
    const t = daytime(between(from, to));
    if (chance(0.15)) addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t - 40000), outcome: "failure" });
    addLogin({ customer_id: p.c.customer_id, device_id: pick(p.devices), ip_address: pick(p.ips), geo: p.c.city, timestamp: iso(t) });
  }
}

function priorTransfers(acc: string) {
  return txns.filter((t) => t.account_id === acc && t.type !== "deposit").map((t) => t.amount);
}
function p95(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(0.95 * (s.length - 1))];
}

// ---------- background population ----------
const BACKGROUND = 300;
for (let i = 0; i < BACKGROUND; i++) {
  const onboarded = chance(0.08) ? between(WINDOW_START - 60 * DAY, WINDOW_START + 30 * DAY) : between(Date.UTC(2021, 0, 1), WINDOW_START - 90 * DAY);
  makePerson({ onboarded });
}
for (const p of [...people]) {
  const from = Math.max(WINDOW_START, Date.parse(p.c.onboarding_date));
  background(p, from, WINDOW_END, int(6, 12));
  if (chance(0.15)) {
    const card: Account = { account_id: uid("CRD", 10), customer_id: p.c.customer_id, product: "cards", account_type: "credit_card", opened_at: p.c.onboarding_date, status: "active" };
    accounts.push(card);
    for (let k = 0, n = int(2, 5); k < n; k++) {
      const m = pick(MERCHANTS);
      addTxn({ account_id: card.account_id, beneficiary_account: m[0], beneficiary_name: m[1], amount: round10(lognormal(2500, 0.6)), timestamp: iso(daytime(between(from, WINDOW_END))), channel: "card", type: "payment" });
    }
  }
  if (chance(0.15)) {
    const type = pick(["health", "health", "motor", "property"]);
    const policy: Account = { account_id: uid("POL", 10), customer_id: p.c.customer_id, product: "insurance", account_type: `${type}_policy`, opened_at: p.c.onboarding_date, status: "active" };
    accounts.push(policy);
    const sumInsured = type === "health" ? pick([300000, 500000, 1000000]) : type === "motor" ? pick([400000, 600000, 900000]) : pick([2000000, 5000000]);
    for (let k = 0, n = pick([0, 1, 1, 2]); k < n; k++) {
      const incident = daytime(between(Math.max(WINDOW_START, Date.parse(policy.opened_at)), WINDOW_END - 25 * DAY));
      addClaim({ policy, type, sumInsured, incident, submitted: incident + int(1, 20) * DAY, amount: round10(sumInsured * (0.05 + rand() * 0.5)), payout: p.bank.account_id, device: p.devices[0] });
    }
  }
}
// A few couples share a laptop (two people, nothing else in common): normal, not recorded.
for (let i = 0; i < 3; i++) {
  const [a, b] = [pick(people), pick(people)];
  if (a === b) continue;
  const laptop = hexId("DEV-");
  for (const p of [a, b]) addLogin({ customer_id: p.c.customer_id, device_id: laptop, ip_address: p.ips[0], geo: p.c.city, timestamp: iso(daytime(between(WINDOW_START, WINDOW_END))) });
}
// Ordinary loan applications.
for (let i = 0; i < 120; i++) {
  const p = pick(people.slice(0, BACKGROUND));
  const t = daytime(between(Math.max(WINDOW_START, Date.parse(p.c.onboarding_date) + 30 * DAY), WINDOW_END - 3 * DAY));
  const status = pick(["approved", "approved", "approved", "approved", "approved", "approved", "approved", "rejected", "rejected", "pending"]);
  const lendAcc: Account = { account_id: uid("LON", 10), customer_id: p.c.customer_id, product: "lending", account_type: "personal_loan", opened_at: isoDate(t), status: status === "approved" ? "active" : "closed" };
  if (status === "approved") accounts.push(lendAcc);
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t - 5 * MIN) });
  const amount = round10(int(50, 500) * 1000);
  const loan: Loan = { application_id: uid("APP", 8), customer_id: p.c.customer_id, device_id: p.devices[0], phone: p.c.phone, email: p.c.email, requested_amount: amount, payout_account: p.bank.account_id, submitted_at: iso(t), status,
    declared_income: Math.round((p.c.declared_income * (0.9 + rand() * 0.25)) / 1000) * 1000, employer: p.c.occupation === "salaried" ? pick(EMPLOYERS) : "Self", loan_purpose: pick(PURPOSES) };
  loans.push(loan);
  if (status === "approved") addTxn({ account_id: LENDER_POOL, beneficiary_account: p.bank.account_id, beneficiary_name: p.c.full_name, amount, timestamp: iso(t + int(1, 2) * DAY), channel: "neft", type: "disbursement", application_id: loan.application_id });
}

// ---------- planted scenarios ----------
const plantDay = (d: number) => PLANT_START + d * DAY + int(9 * 60, 18 * 60) * MIN;
const MULE = uid("EXT", 10);
const MULE_NAME = `${pick(FIRST)} ${pick(SURNAMES)} Traders`;

/** Established customer with enough history for robust baselines. */
function establishedPerson(): Person {
  const p = makePerson({ onboarded: between(Date.UTC(2020, 0, 1), Date.UTC(2024, 0, 1)), medianAmt: round10(int(5, 20) * 1000) });
  background(p, WINDOW_START, PLANT_START - DAY, int(22, 28));
  return p;
}

// S1: two account takeovers. The second pays the loan ring's mule (S6).
function accountTakeover(id: string, day: number, beneficiary: { account: string; name: string }) {
  const victim = establishedPerson();
  const t0 = plantDay(day);
  const attackerDevice = hexId("DEV-");
  const attackerIp = ip();
  const geo = pick(CITIES.filter((c) => c !== victim.c.city));
  for (let i = 0; i < 5; i++) addLogin({ customer_id: victim.c.customer_id, device_id: attackerDevice, ip_address: attackerIp, geo, timestamp: iso(t0 + i * int(60, 110) * 1000), outcome: "failure" });
  const ok = addLogin({ customer_id: victim.c.customer_id, device_id: attackerDevice, ip_address: attackerIp, geo, timestamp: iso(t0 + 8 * MIN) });
  const benAdd = addLogin({ customer_id: victim.c.customer_id, device_id: attackerDevice, ip_address: attackerIp, geo, timestamp: iso(t0 + 11 * MIN), event_type: "beneficiary_add" });
  const amount = round10(Math.max(3 * p95(priorTransfers(victim.bank.account_id)), 8 * victim.medianAmt));
  const tx = addTxn({ account_id: victim.bank.account_id, beneficiary_account: beneficiary.account, beneficiary_name: beneficiary.name, amount, timestamp: iso(t0 + 14 * MIN), channel: victim.channels[0] });
  truth.push({ id: `${id}-ATO`, scenario: "Account takeover", kind: "fraud", detector: "FD-03", expected_level: "High", entities: { customer_ids: [victim.c.customer_id] }, note: `5 failures → success on new device ${attackerDevice} → beneficiary added (${benAdd.event_id}) → transfer ${tx.transaction_id}` });
  truth.push({ id: `${id}-TXN`, scenario: "Account takeover transfer", kind: "fraud", detector: "FD-01", expected_level: "High", entities: { transaction_ids: [tx.transaction_id] }, note: `Transfer of ₹${amount} right after the takeover login ${ok.event_id}` });
  return { victim, tx };
}
accountTakeover("S1a", 9, { account: uid("EXT", 10), name: `${pick(FIRST)} ${pick(SURNAMES)}` });

// S2: amount outlier to a new beneficiary, no login anomaly.
{
  const p = establishedPerson();
  const amount = round10(Math.max(200000, 3 * p95(priorTransfers(p.bank.account_id))));
  const t = plantDay(4);
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t - 6 * MIN) });
  const tx = addTxn({ account_id: p.bank.account_id, beneficiary_account: uid("EXT", 10), beneficiary_name: `${pick(FIRST)} ${pick(SURNAMES)}`, amount, timestamp: iso(t), channel: p.channels[0] });
  truth.push({ id: "S2", scenario: "Unusual amount to new beneficiary", kind: "fraud", detector: "FD-01", expected_level: "Medium", entities: { transaction_ids: [tx.transaction_id] }, note: `₹${amount} vs median ₹${p.medianAmt}` });
}

// S3: rapid transfers to new beneficiaries through a rarely used channel (account 60–300 days old).
{
  const p = makePerson({ onboarded: PLANT_START - int(60, 300) * DAY, medianAmt: round10(int(3, 8) * 1000) });
  p.channels = ["mobile", "netbanking"];
  background(p, Math.max(WINDOW_START, Date.parse(p.c.onboarding_date)), PLANT_START - DAY, int(22, 26));
  const t0 = plantDay(6);
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t0 - 4 * MIN) });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const tx = addTxn({ account_id: p.bank.account_id, beneficiary_account: uid("EXT", 10), beneficiary_name: `${pick(FIRST)} ${pick(SURNAMES)}`, amount: round10(p.medianAmt * int(2, 4)), timestamp: iso(t0 + i * 2 * MIN), channel: "api" });
    ids.push(tx.transaction_id);
  }
  truth.push({ id: "S3", scenario: "Rapid transfers to new beneficiaries", kind: "fraud", detector: "FD-01", expected_level: "Medium", entities: { transaction_ids: ids.slice(2) }, note: "4 transfers in 6 minutes via api; transfers 3 and 4 complete the burst" });
}

// S4: brand-new account receives ₹3 lakh and is drained within a day.
{
  const opened = plantDay(2);
  const p = makePerson({ onboarded: opened, medianAmt: 5000 });
  const inflowT = opened + 2 * DAY;
  addTxn({ account_id: uid("EXT", 10), beneficiary_account: p.bank.account_id, beneficiary_name: p.c.full_name, amount: 300000, timestamp: iso(inflowT), channel: "imps", type: "deposit" });
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(inflowT + 5 * 3600000) });
  const tx = addTxn({ account_id: p.bank.account_id, beneficiary_account: uid("EXT", 10), beneficiary_name: `${pick(FIRST)} ${pick(SURNAMES)}`, amount: 285000, timestamp: iso(inflowT + 5 * 3600000 + 4 * MIN), channel: "mobile" });
  truth.push({ id: "S4", scenario: "New account drained after inflow", kind: "fraud", detector: "FD-01", expected_level: "High", entities: { transaction_ids: [tx.transaction_id] }, note: "Account 3 days old; 95% of a ₹3 lakh inflow sent out within hours" });
}

// S5: loan-application ring — 4 new, unrelated customers on one device, shared payout account P.
const ring: Person[] = [];
{
  const surnames = shuffle([...SURNAMES]).slice(0, 4);
  const cities = shuffle([...CITIES]).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    const p = makePerson({ onboarded: PLANT_START + int(0, 2) * DAY, surname: surnames[i], city: cities[i], medianAmt: 5000 });
    p.c.onboarding_channel = "mobile_app";
    ring.push(p);
  }
  // Two applicants give the same mobile number, written differently.
  ring[2].c.phone = `+91 ${ring[1].c.phone.slice(0, 5)} ${ring[1].c.phone.slice(5)}`;
  const ringDevice = hexId("DEV-");
  const payout: Account = { account_id: uid("ACC", 10), customer_id: ring[0].c.customer_id, product: "banking", account_type: "savings", opened_at: isoDate(plantDay(3)), status: "active" };
  accounts.push(payout);
  const appIds: string[] = [];
  let disbursed = 0;
  let lastDisbursal = 0;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const t = plantDay(4) + i * int(4, 10) * 3600000;
    addLogin({ customer_id: p.c.customer_id, device_id: ringDevice, ip_address: ip(), geo: p.c.city, timestamp: iso(t - 3 * MIN) });
    const amount = round10(int(100, 200) * 1000);
    const toAccount = i < 3 ? payout.account_id : p.bank.account_id;
    // Applicants claim three times the income on their profile, all at the same (unverifiable) employer.
    const loan: Loan = { application_id: uid("APP", 8), customer_id: p.c.customer_id, device_id: ringDevice, phone: p.c.phone, email: p.c.email, requested_amount: amount, payout_account: toAccount, submitted_at: iso(t), status: "approved",
      declared_income: p.c.declared_income * 3, employer: "Zenith Global Services", loan_purpose: "business" };
    loans.push(loan);
    appIds.push(loan.application_id);
    accounts.push({ account_id: uid("LON", 10), customer_id: p.c.customer_id, product: "lending", account_type: "personal_loan", opened_at: isoDate(t + DAY), status: "active" });
    const dt = plantDay(6) + i * 30 * MIN;
    addTxn({ account_id: LENDER_POOL, beneficiary_account: toAccount, beneficiary_name: p.c.full_name, amount, timestamp: iso(dt), channel: "neft", type: "disbursement", application_id: loan.application_id });
    if (i < 3) disbursed += amount;
    lastDisbursal = Math.max(lastDisbursal, dt);
  }
  addLogin({ customer_id: ring[0].c.customer_id, device_id: ringDevice, ip_address: ip(), geo: ring[0].c.city, timestamp: iso(lastDisbursal + 3 * 3600000 - 5 * MIN) });
  const onward = addTxn({ account_id: payout.account_id, beneficiary_account: MULE, beneficiary_name: MULE_NAME, amount: round10(disbursed * 0.9), timestamp: iso(lastDisbursal + 3 * 3600000), channel: "mobile" });
  const ringCustomers = ring.map((p) => p.c.customer_id);
  truth.push({ id: "S5-LOAN", scenario: "Loan application ring", kind: "fraud", detector: "FD-05", expected_level: "High", entities: { application_ids: appIds }, note: `4 applications from ${ringDevice}; 3 pay out to ${payout.account_id}; applicants ${ring[1].c.customer_id} and ${ring[2].c.customer_id} share a phone` });
  truth.push({ id: "S5-DEVICE", scenario: "Coordinated device use by loan ring", kind: "fraud", detector: "FD-02", expected_level: "High", entities: { device_ids: [ringDevice] }, note: "4 new, unrelated profiles first used one device within 48 h" });
  truth.push({ id: "S5-ONWARD", scenario: "Loan proceeds forwarded to mule", kind: "fraud", detector: "FD-01", expected_level: "High", entities: { transaction_ids: [onward.transaction_id] }, note: `90% of disbursements forwarded from new account ${payout.account_id} to ${MULE}` });

  // S6: the second takeover pays the same mule, connecting both schemes.
  const ato2 = accountTakeover("S6", 10, { account: MULE, name: MULE_NAME });
  truth.push({ id: "S6-CROSS", scenario: "Cross-system organised fraud", kind: "fraud", detector: "FD-06", expected_level: "High", entities: { customer_ids: [ato2.victim.c.customer_id, ...ringCustomers] }, note: `Takeover transfer ${ato2.tx.transaction_id} and loan proceeds both reach ${MULE}` });

  // S9: two unrelated new customers claim for the same garage invoice on fresh motor policies,
  // filed from the ring's device and paid into the ring's payout account — insurance joins the network.
  const claimants: Person[] = [];
  const invoice = docHash();
  const garage = pick(PROVIDERS.motor);
  const claimIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = makePerson({ onboarded: PLANT_START + int(0, 1) * DAY, surname: pick(SURNAMES.filter((x) => !ring.some((r) => r.c.full_name.endsWith(x)))), medianAmt: 5000 });
    claimants.push(p);
    const policy: Account = { account_id: uid("POL", 10), customer_id: p.c.customer_id, product: "insurance", account_type: "motor_policy", opened_at: isoDate(plantDay(2)), status: "active" };
    accounts.push(policy);
    const incident = plantDay(5);
    const c = addClaim({ policy, type: "motor", sumInsured: 500000, incident, submitted: incident + (i + 1) * DAY, amount: 460000 + i * 5000, payout: payout.account_id, device: ringDevice, provider: garage, doc: invoice, status: "under_review" });
    claimIds.push(c.claim_id);
  }
  truth.push({ id: "S9-CLAIMS", scenario: "Duplicate claims paid into the ring's account", kind: "fraud", detector: "FD-07", expected_level: "High", entities: { claim_ids: claimIds }, note: `Same garage invoice ${invoice} on two new policies; both pay out to ${payout.account_id}` });
  truth.push({ id: "S9-CROSS", scenario: "Insurance, lending and banking linked", kind: "fraud", detector: "FD-06", expected_level: "High", entities: { claim_ids: claimIds, customer_ids: [ring[0].c.customer_id] }, note: "Claims, loan disbursements and the mule transfer share one account" });
}

// S7: synthetic identities — one national ID under two names, an email reused by a third profile
// (written in different case), and an applicant who would have been 16 at onboarding.
{
  const surnames = shuffle([...SURNAMES]).slice(0, 3);
  const cities = shuffle([...CITIES]).slice(0, 3);
  const a = makePerson({ onboarded: plantDay(1), surname: surnames[0], city: cities[0] });
  const b = makePerson({ onboarded: plantDay(3), surname: surnames[1], city: cities[1] });
  const c = makePerson({ onboarded: plantDay(4), surname: surnames[2], city: cities[2] });
  b.c.national_id = a.c.national_id;
  b.c.dob = isoDate(Date.parse(a.c.dob) + int(400, 4000) * DAY);
  c.c.email = a.c.email.toUpperCase();
  c.c.dob = isoDate(plantDay(4) - 16 * 365 * DAY);
  truth.push({ id: "S7-IDENTITY", scenario: "Synthetic identity profiles", kind: "fraud", detector: "FD-04", expected_level: "High", entities: { customer_ids: [a.c.customer_id, b.c.customer_id, c.c.customer_id] }, note: `National ID ${a.c.national_id} used by ${a.c.full_name} and ${b.c.full_name}; ${c.c.customer_id} reuses ${a.c.customer_id}'s email and claims to be 16` });
}

// S8: phished credentials — no failed logins; password reset from a new device in another city,
// then a new beneficiary and a large transfer.
{
  const victim = establishedPerson();
  const t0 = plantDay(12);
  const device = hexId("DEV-");
  const attackerIp = ip();
  const geo = pick(CITIES.filter((c) => c !== victim.c.city));
  addLogin({ customer_id: victim.c.customer_id, device_id: device, ip_address: attackerIp, geo, timestamp: iso(t0), event_type: "password_reset" });
  const ok = addLogin({ customer_id: victim.c.customer_id, device_id: device, ip_address: attackerIp, geo, timestamp: iso(t0 + 2 * MIN) });
  addLogin({ customer_id: victim.c.customer_id, device_id: device, ip_address: attackerIp, geo, timestamp: iso(t0 + 5 * MIN), event_type: "beneficiary_add" });
  const amount = round10(Math.max(3 * p95(priorTransfers(victim.bank.account_id)), 8 * victim.medianAmt));
  const tx = addTxn({ account_id: victim.bank.account_id, beneficiary_account: uid("EXT", 10), beneficiary_name: `${pick(FIRST)} ${pick(SURNAMES)}`, amount, timestamp: iso(t0 + 9 * MIN), channel: victim.channels[0] });
  truth.push({ id: "S8-ATO", scenario: "Phishing takeover (no failed logins)", kind: "fraud", detector: "FD-03", expected_level: "High", entities: { customer_ids: [victim.c.customer_id] }, note: `Password reset from new device ${device} in ${geo} → login ${ok.event_id} → beneficiary added → transfer ${tx.transaction_id}` });
  truth.push({ id: "S8-TXN", scenario: "Phishing takeover transfer", kind: "fraud", detector: "FD-01", expected_level: "High", entities: { transaction_ids: [tx.transaction_id] }, note: `₹${amount} minutes after a password reset from an unfamiliar device` });
}

// L5: a couple who give the same home phone number — shared contact inside one household.
{
  const surname = pick(SURNAMES);
  const city = pick(CITIES);
  const address = `${int(1, 400)}, ${pick(STREETS)}, ${city}`;
  const a = makePerson({ onboarded: between(Date.UTC(2019, 0, 1), Date.UTC(2023, 0, 1)), surname, address, city });
  const b = makePerson({ onboarded: between(Date.UTC(2019, 0, 1), Date.UTC(2023, 0, 1)), surname, address, city });
  b.c.phone = a.c.phone;
  background(a, WINDOW_START, WINDOW_END, int(6, 10));
  background(b, WINDOW_START, WINDOW_END, int(6, 10));
  truth.push({ id: "L5", scenario: "Household sharing a phone number", kind: "lookalike", detector: "FD-04", max_level: "Low", entities: { customer_ids: [a.c.customer_id, b.c.customer_id] }, note: `${a.c.full_name} and ${b.c.full_name} give the same phone at the same address` });
}

// S10: double-dipping — one hospital stay claimed on an old health policy and on a second policy bought days earlier.
{
  const p = establishedPerson();
  const oldPolicy: Account = { account_id: uid("POL", 10), customer_id: p.c.customer_id, product: "insurance", account_type: "health_policy", opened_at: "2022-04-01", status: "active" };
  const newPolicy: Account = { account_id: uid("POL", 10), customer_id: p.c.customer_id, product: "insurance", account_type: "health_policy", opened_at: isoDate(plantDay(0)), status: "active" };
  accounts.push(oldPolicy, newPolicy);
  const hospital = pick(PROVIDERS.health);
  const incident = plantDay(6);
  addClaim({ policy: oldPolicy, type: "health", sumInsured: 500000, incident, submitted: incident + 3 * DAY, amount: 180000, payout: p.bank.account_id, device: p.devices[0], provider: hospital });
  const second = addClaim({ policy: newPolicy, type: "health", sumInsured: 200000, incident: incident + DAY, submitted: incident + 5 * DAY, amount: 185000, payout: p.bank.account_id, device: p.devices[0], provider: hospital });
  truth.push({ id: "S10-DOUBLE", scenario: "Same hospital stay claimed on two policies", kind: "fraud", detector: "FD-07", expected_level: "Medium", entities: { claim_ids: [second.claim_id] }, note: `Second policy ${newPolicy.account_id} started ${6} days before the admission` });
}

// L6: a household's health claims — the wife's claim is paid into her husband's account.
{
  const surname = pick(SURNAMES);
  const city = pick(CITIES);
  const address = `${int(1, 400)}, ${pick(STREETS)}, ${city}`;
  const husband = makePerson({ onboarded: Date.UTC(2020, 2, 1), surname, address, city });
  const wife = makePerson({ onboarded: Date.UTC(2020, 2, 1), surname, address, city });
  background(husband, WINDOW_START, WINDOW_END, int(6, 10));
  background(wife, WINDOW_START, WINDOW_END, int(6, 10));
  const policy: Account = { account_id: uid("POL", 10), customer_id: wife.c.customer_id, product: "insurance", account_type: "health_policy", opened_at: "2020-03-01", status: "active" };
  accounts.push(policy);
  const incident = daytime(WINDOW_START + int(20, 60) * DAY);
  const c = addClaim({ policy, type: "health", sumInsured: 500000, incident, submitted: incident + 4 * DAY, amount: 85000, payout: husband.bank.account_id, device: wife.devices[0] });
  truth.push({ id: "L6", scenario: "Household claim paid to a spouse's account", kind: "lookalike", detector: "FD-07", max_level: "Low", entities: { claim_ids: [c.claim_id] }, note: "Long-standing policy, payout to the husband's account at the same address" });
}

// L1: two families share a tablet for months — same surname and address, no money link.
for (let f = 0; f < 2; f++) {
  const surname = pick(SURNAMES);
  const city = pick(CITIES);
  const address = `${int(1, 400)}, ${pick(STREETS)}, ${city}`;
  const tablet = hexId("DEV-");
  const members: Person[] = [];
  for (let i = 0; i < 3; i++) {
    const p = makePerson({ onboarded: between(Date.UTC(2019, 0, 1), Date.UTC(2024, 6, 1)), surname, address, city });
    background(p, WINDOW_START, WINDOW_END, int(8, 12));
    members.push(p);
  }
  const firstUse = [WINDOW_START + int(1, 5) * DAY, WINDOW_START + int(30, 45) * DAY, WINDOW_START + int(60, 70) * DAY];
  members.forEach((p, i) => {
    for (let k = 0; k < 4; k++) {
      const t = k === 0 ? firstUse[i] : between(firstUse[i] + DAY, WINDOW_END - 2 * DAY);
      addLogin({ customer_id: p.c.customer_id, device_id: tablet, ip_address: members[0].ips[0], geo: city, timestamp: iso(daytime(t)) });
    }
  });
  addLogin({ customer_id: members[0].c.customer_id, device_id: tablet, ip_address: members[0].ips[0], geo: city, timestamp: iso(daytime(WINDOW_END - DAY)) });
  truth.push({ id: `L1${"ab"[f]}`, scenario: "Family sharing a tablet", kind: "lookalike", detector: "FD-02", max_level: "Low", entities: { device_ids: [tablet] }, note: `3 members of the ${surname} household at one address, long-standing shared use` });
}

// L2: businesses that routinely move ₹2–5 lakh to established vendors.
for (let b = 0; b < 3; b++) {
  const p = makePerson({ onboarded: between(Date.UTC(2019, 0, 1), Date.UTC(2023, 0, 1)), medianAmt: 300000, accountType: "current" });
  p.c.full_name = `${pick(SURNAMES)} ${pick(["Traders", "Exports", "Enterprises", "Logistics"])}`;
  const vendors = [0, 1, 2].map(() => ({ account: uid("EXT", 10), name: `${pick(SURNAMES)} ${pick(["Steel", "Textiles", "Supplies", "Agencies"])}` }));
  for (let w = 0; w < 15; w++) {
    const t = daytime(WINDOW_START + w * 6 * DAY + int(0, 2) * DAY);
    addTxn({ account_id: uid("EXT", 10), beneficiary_account: p.bank.account_id, beneficiary_name: p.c.full_name, amount: round10(int(300, 700) * 1000), timestamp: iso(t - DAY), channel: "rtgs", type: "deposit" });
    addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t - 10 * MIN) });
    addTxn({ account_id: p.bank.account_id, beneficiary_account: vendors[w % 3].account, beneficiary_name: vendors[w % 3].name, amount: round10(int(200, 500) * 1000), timestamp: iso(t), channel: "netbanking" });
  }
  const t = plantDay(11);
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t - 8 * MIN) });
  const tx = addTxn({ account_id: p.bank.account_id, beneficiary_account: vendors[0].account, beneficiary_name: vendors[0].name, amount: 450000, timestamp: iso(t), channel: "netbanking" });
  truth.push({ id: `L2${"abc"[b]}`, scenario: "High-value but normal business transfer", kind: "lookalike", detector: "FD-01", max_level: "Low", entities: { transaction_ids: [tx.transaction_id] }, note: "₹4.5 lakh to a vendor paid 5 times before; within the customer's usual range" });
}

// L3: forgotten password — failures and success on the customer's own device, nothing after.
{
  const p = establishedPerson();
  const t0 = plantDay(7);
  for (let i = 0; i < 4; i++) addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t0 + i * 50 * 1000), outcome: "failure" });
  addLogin({ customer_id: p.c.customer_id, device_id: p.devices[0], ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t0 + 5 * MIN) });
  truth.push({ id: "L3", scenario: "Forgotten password", kind: "lookalike", detector: "FD-03", max_level: "Low", entities: { customer_ids: [p.c.customer_id] }, note: "4 failures then success on a known device; no follow-on activity" });
}

// L4: customer gets a new phone — first-try login on the new device, normal transfer the next day.
{
  const p = establishedPerson();
  const newPhone = hexId("DEV-");
  const t0 = plantDay(8);
  addLogin({ customer_id: p.c.customer_id, device_id: newPhone, ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t0) });
  addLogin({ customer_id: p.c.customer_id, device_id: newPhone, ip_address: p.ips[0], geo: p.c.city, timestamp: iso(t0 + DAY) });
  const payee = p.payees[0];
  addTxn({ account_id: p.bank.account_id, beneficiary_account: payee.account, beneficiary_name: payee.name, amount: round10(p.medianAmt), timestamp: iso(t0 + DAY + 5 * MIN), channel: p.channels[0] });
  truth.push({ id: "L4", scenario: "New phone, normal behaviour", kind: "lookalike", detector: "FD-03", max_level: "None", entities: { customer_ids: [p.c.customer_id] }, note: `First login on new device ${newPhone} succeeded first time` });
}

// ---------- output ----------
const byTime = <T extends { timestamp?: string; submitted_at?: string }>(a: T, b: T) =>
  (a.timestamp ?? a.submitted_at ?? "").localeCompare(b.timestamp ?? b.submitted_at ?? "");
txns.sort(byTime);
logins.sort(byTime);
loans.sort(byTime);

const COLUMNS = {
  customers: ["customer_id", "full_name", "dob", "national_id", "phone", "email", "address", "city", "onboarding_date", "onboarding_channel", "kyc_status", "occupation", "declared_income"],
  accounts: ["account_id", "customer_id", "product", "account_type", "opened_at", "status"],
  transactions: ["transaction_id", "account_id", "beneficiary_account", "beneficiary_name", "amount", "currency", "timestamp", "channel", "status", "type", "application_id"],
  login_events: ["event_id", "customer_id", "device_id", "ip_address", "geo", "timestamp", "outcome", "event_type"],
  loan_applications: ["application_id", "customer_id", "device_id", "phone", "email", "requested_amount", "payout_account", "submitted_at", "status", "declared_income", "employer", "loan_purpose"],
  insurance_claims: ["claim_id", "policy_id", "customer_id", "claim_type", "incident_date", "submitted_at", "claim_amount", "sum_insured", "policy_start_date", "provider_id", "payout_account", "device_id", "document_hash", "status", "description"],
} as const;
claims.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
const DATA: Record<keyof typeof COLUMNS, object[]> = { customers, accounts, transactions: txns, login_events: logins, loan_applications: loans, insurance_claims: claims };

fs.mkdirSync(OUT, { recursive: true });
const csv = (rows: object[], columns: readonly string[]) => Papa.unparse(rows as Record<string, unknown>[], { columns: [...columns] }) + "\n";

const wb = XLSX.utils.book_new();
for (const [name, columns] of Object.entries(COLUMNS)) {
  const rows = DATA[name as keyof typeof COLUMNS];
  fs.writeFileSync(path.join(OUT, `${name}.csv`), csv(rows, columns));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: [...columns] }), name);
}
fs.writeFileSync(path.join(OUT, "tracex.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));
fs.writeFileSync(path.join(OUT, "tracex.json"), JSON.stringify(DATA));

// Deliberately broken rows for the validation demo: one valid row plus six problems.
{
  const base = txns.find((t) => t.type === "transfer" && t.account_id.startsWith("ACC"))!;
  const existing = txns.filter((t) => t.type === "transfer")[5];
  const fresh = { ...base, transaction_id: uid("TXN", 10), timestamp: iso(WINDOW_END - DAY), amount: 1200 };
  const rows = [
    fresh,
    { ...base, transaction_id: "", amount: 5000 },
    { ...base, transaction_id: uid("TXN", 10), timestamp: "31/02/2026 10:00" },
    { ...base, transaction_id: uid("TXN", 10), amount: -2500 },
    { ...base, transaction_id: uid("TXN", 10), account_id: "ACC0000000000", beneficiary_account: "EXT0000000000" },
    { ...existing, amount: existing.amount + 99999 },
    { ...existing },
  ];
  fs.writeFileSync(path.join(OUT, "transactions_with_errors.csv"), csv(rows, COLUMNS.transactions));
}

// The same kind of login data with another system's column names and date format.
{
  const sample = shuffle(people.slice(0, BACKGROUND)).slice(0, 20);
  const rows = sample.map((p) => {
    const t = new Date(daytime(WINDOW_END - int(1, 10) * DAY));
    const dd = String(t.getUTCDate()).padStart(2, "0");
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    return {
      "Login ID": uid("LGN", 10),
      "Cust ID": p.c.customer_id,
      "Device": p.devices[0],
      "IP": p.ips[0],
      "Location": p.c.city,
      "Login Time": `${dd}/${mm}/${t.getUTCFullYear()} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`,
      "Auth Result": pick(["SUCCESS", "Success", "OK"]),
      "Action": "login",
    };
  });
  fs.writeFileSync(path.join(OUT, "logins_alt_headers.csv"), Papa.unparse(rows) + "\n");
}

fs.writeFileSync(path.join(OUT, "ground_truth.json"), JSON.stringify({ seed: SEED, generated_for: "TRACE X evaluation only — never read by detection", items: truth }, null, 2));

console.log(
  `seed ${SEED} → ${OUT}: ${customers.length} customers, ${accounts.length} accounts, ${txns.length} transactions, ` +
  `${logins.length} login events, ${loans.length} loan applications, ${claims.length} claims, ${truth.length} ground-truth items`,
);
