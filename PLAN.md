# TRACE X — Level 1 implementation spec

Azentio AI Hackathon, Challenge #01: Digital Fraud Investigation System. Level 1 window: 0–3 hours.

The judges assess **live application behaviour**. Every decision below favours "works correctly on data we've never seen" over architecture.

**One-line pitch:** TRACE X connects customer, transaction, login and loan data into one model of related records. It detects fraud that looks normal inside any single system, explains every score, clears legitimate lookalikes, and keeps a tamper-proof case trail.

---

## 1. Requirement traceability (check this first and last)

| # | Official requirement | Implemented by |
|---|---|---|
| R1 | Upload **or select** data from different systems | §7 Ingest screen: file upload and a bundled sample-dataset picker |
| R2 | Customer/account, transaction, device/login data | §3 tables `customers`, `accounts`, `transactions`, `login_events` |
| R3 | CSV, Excel, JSON | §4 parsers (Papa Parse, SheetJS, JSON) |
| R4 | Validate, flag missing mandatory fields, never silently ignore | §4 validation, `import_errors`, downloadable error report |
| R5 | Common structure linked by customer/account/application/device/transaction ID | §3 shared IDs, `application_id` on disbursements, provenance on every row |
| R6 | Configurable rules + statistics/ML | §5 `policy.json` (shown on the Rules page), median/MAD baselines |
| R7 | Suspicious transfers | FD-01 |
| R8 | Shared devices, and whether that is suspicious | FD-02 (with household mitigation) |
| R9 | Repeated login failures → success / sensitive activity | FD-03 |
| R10 | Legitimate lookalikes | Mitigations in every detector, the "Reviewed – not escalated" view, planted lookalikes in the evaluation |
| R11 | ≥ 1 extra scenario | FD-05 loan-application ring; FD-06 cross-system (differentiator) |
| R12 | Risk classification for every detection, built from multiple indicators | §5.1 score 0–100 → Low/Medium/High |
| R13 | High value that is normal for the customer ≠ fraud; the same amount after failed logins and a new device scores higher | FD-01 `WITHIN_CUSTOMER_NORM` mitigation and `PRECEDED_BY_LOGIN_RISK` signal |
| R14 | Explain contributing factors | Signals and mitigations table with weights and evidence links |
| R15 | Dashboard: processed records, flagged events, risk distribution, categories | §7 Dashboard |
| R16 | Filters: customer, transaction, product, risk, date, detection type | §6 `GET /api/alerts` + Alerts screen |
| R17 | Selecting an alert shows the event, reasons, supporting records | §7 Alert detail: primary event, signals, raw source rows with file and row number |
| R18 | Case: ID, customer/account, category, risk, evidence, status | §3 `cases`, `case_decisions` |
| R19 | Record a decision (Requires Investigation / False Positive) | §7 Case detail form (+ Escalated, Dismissed) |
| R20 | Preserve the original alert when its classification changes | Insert-only `alerts` + SQLite trigger; decisions append-only with optional revised level and category |

---

## 2. Stack (decided, don't revisit)

| Concern | Choice | Notes |
|---|---|---|
| App | **Next.js (App Router, TypeScript), one app** | Route handlers serve the API; server components read the DB directly |
| DB | **SQLite through libSQL** (`@libsql/client`, raw SQL in `lib/db/schema.ts`) | Local file `file:./tracex.db`; Turso in deployment, with the same code. Drizzle was dropped in S1: the schema, triggers and `json_each` filters are plain SQL, and it removes a migration step. |
| Validation | **zod** | Per-row, per-field errors |
| CSV | **papaparse** | `header: true`, `skipEmptyLines: 'greedy'` |
| Excel | **SheetJS from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`** | Never `xlsx@0.18.5` from npm: it has a prototype-pollution CVE that a crafted upload can trigger |
| UI | Tailwind + shadcn/ui + lucide-react + Recharts | Same toolkit as azentio-collective |
| Graph view (optional) | cytoscape | Cut first if time is short |
| Tests | vitest; scripts run with tsx | |
| Deploy | Vercel + Turso | Vercel caps request bodies at 4.5 MB; sample files are about 1 MB |

No auth for Level 1. The analyst types a name once; it is stored in `localStorage` and sent with each decision. State this in the README's known limitations.

### Folder layout
```
Trace-X/
  app/
    page.tsx                      # Dashboard
    ingest/page.tsx
    alerts/page.tsx  alerts/[id]/page.tsx
    cases/page.tsx   cases/[id]/page.tsx
    customers/[id]/page.tsx       # timeline + linked entities
    rules/page.tsx                # policy viewer
    evaluation/page.tsx
    api/…                         # §6
  lib/
    db/schema.ts  db/client.ts      # tables + immutability triggers, applied on first use
    ingest/aliases.ts  ingest/parse.ts  ingest/validate.ts  ingest/load.ts
    detect/context.ts             # loads data, builds indexes and baselines once
    detect/fd01-transfer.ts  fd02-device.ts  fd03-ato.ts  fd05-loan-ring.ts  fd06-cross-system.ts
    detect/score.ts  detect/run.ts  detect/cases.ts
    util/normalize.ts  util/hash.ts  util/stats.ts  util/unionfind.ts
  config/policy.json
  scripts/generate.ts             # seeded synthetic data
  data/samples/seed-1/ seed-2/ seed-3/   # committed generator output
  tests/ingest.test.ts  detect.test.ts  integrity.test.ts
  README.md  KNOWN_LIMITATIONS.md  PLAN.md
```

---

## 3. Data model

### 3.1 Source tables (populated by ingestion)
Every source row also has `batch_id`, `source_file`, `source_row`, and `row_hash` (sha256 of the normalised row).
Fields marked `*` are mandatory.

**customers**
- `customer_id`* (PK), `full_name`*, `phone`*, `email`*, `onboarding_date`*
- optional: `dob`, `national_id`, `address`, `city`, `onboarding_channel`, `kyc_status`
- derived: `surname`, `address_norm`, `phone_norm`, `email_norm`, `name_norm`

**accounts**
- `account_id`* (PK), `customer_id`*, `product`*, `opened_at`*
- optional: `account_type`, `status`
- `product` takes one of `banking | lending | insurance | cards`

**transactions**
- `transaction_id`* (PK), `account_id`*, `beneficiary_account`*, `amount`* (> 0), `timestamp`*, `channel`, `status`
- if the whole `channel` or `status` column is absent, rows get `unknown` / `completed` and the import shows a file-level notice (added in S3: uploads from other systems often lack these)
- optional: `beneficiary_name`, `currency` (default INR), `type`, `application_id`
- `status` takes `completed | pending | failed | reversed`
- `type` takes `transfer | payment | disbursement | deposit`
- `application_id` is set on loan disbursements; this is the lending ↔ core banking link
- `direction` is derived: `out` when `account_id` is ours; inflows are rows where `beneficiary_account` is one of our accounts

**login_events**
- `event_id`* (PK), `customer_id`*, `device_id`*, `timestamp`*, `outcome`*
- optional: `ip_address`, `geo`, `event_type`
- `outcome` takes `success | failure`
- `event_type` takes `login | password_reset | beneficiary_add | device_change | profile_change` (default `login`)

**loan_applications** (the extra scenario)
- `application_id`* (PK), `customer_id`*, `requested_amount`*, `payout_account`*, `submitted_at`*
- optional: `device_id`, `phone`, `email`, `status`

### 3.2 Ingestion bookkeeping
- `import_batches(batch_id, filename, dataset_type, format, total_rows, accepted, rejected, duplicates, warnings, created_at)`
- `import_errors(id, batch_id, source_row, field, severity: error|warning, message, raw_json)`

### 3.3 Detection and investigation (insert-only)
- `detection_runs(run_id, policy_version, input_hash, started_at, finished_at, counts_json)`
- `alerts`, with columns:
  - `alert_id`, `fingerprint` UNIQUE, `first_run_id`, `detector`, `category`
  - subject: `subject_type`, `subject_id`
  - linked IDs: `customer_ids` JSON, `account_ids` JSON, `transaction_ids` JSON, `device_ids` JSON, `application_ids` JSON
  - `products` JSON, `event_time`, `primary_ref` JSON `{table,id}`
  - scoring: `raw_score`, `score`, `level`, `signals_json`, `mitigations_json`, `evidence_refs_json`
  - `created_at`
- `run_alerts(run_id, alert_id)`: which alerts each run produced. Screens show the latest run; older alerts stay in history.
- `cases(case_id, case_key UNIQUE, primary_customer_id, primary_account_id, category, level, score, alert_ids JSON, created_at)`
- `case_decisions`, append-only, with columns:
  - `id`, `case_id`, `decision`, `note`, `analyst`
  - `revised_level` (nullable), `revised_category` (nullable)
  - `created_at`
  - `decision` takes `REQUIRES_INVESTIGATION | ESCALATED | FALSE_POSITIVE | DISMISSED`

**Case status** is `OPEN` when there are no decisions; otherwise it is the latest decision. The case page shows the original level and category next to any revised ones.

### 3.4 Integrity rules
- `fingerprint = sha256(detector + policy_version + sorted evidence IDs)`.
  - Inserts use `INSERT … ON CONFLICT(fingerprint) DO NOTHING`.
  - Re-running on the same data creates 0 new alerts.
  - Changing the policy creates new alerts and leaves the old ones untouched.
- `case_key = sha256(sorted member fingerprints)`. Cases are inserted the same way, so re-runs don't create duplicates.
- Triggers in `db/triggers.sql`:
  - `BEFORE UPDATE ON alerts` → `RAISE(ABORT,'alerts are immutable')`
  - the same for `BEFORE DELETE`
  - the same for both on `case_decisions`
- **Reset workspace** (a demo convenience) drops and recreates all tables inside a transaction. It is the only path that removes alerts, and it is labelled as such.

---

## 4. Ingestion

1. **Parse**
   - `.csv` → Papa Parse
   - `.xlsx`/`.xls` → SheetJS, one dataset per sheet. Sheet names (`customers`, `transactions`, …) pick the type; otherwise detect it from headers.
   - `.json` → either an array of objects, or `{customers:[…], transactions:[…], …}`
2. **Normalise headers**: lowercase, trim, and replace non-alphanumeric characters with `_`, then look the result up in `aliases.ts`. Examples:
   - `cust_id`, `customerid`, `customer_no`, `client_id` → `customer_id`
   - `txn_id`, `transactionid`, `reference` → `transaction_id`
   - `from_account`, `sender_account`, `debit_account` → `account_id`
   - `to_account`, `beneficiary`, `payee_account`, `credit_account` → `beneficiary_account`
   - `date`, `time`, `datetime`, `created_at`, `txn_time` → `timestamp`
   - `result`, `auth_result`, `status` (in login files) → `outcome`
   - `mobile`, `phone_number`, `contact` → `phone`
3. **Detect the dataset type**: score the headers against each type's mandatory fields and pick the best match. If fewer than 60% of a type's mandatory fields match, return `400` with "Unrecognised file", listing the missing columns. The user can override the type in a dropdown.
4. **Validate each row with zod.** Value normalisation:
   - timestamps: accept ISO 8601, `YYYY-MM-DD HH:mm[:ss]`, `DD/MM/YYYY HH:mm` and Excel serial dates, then convert to UTC ISO
   - amounts: strip `,`, `₹` and spaces; the value must be > 0
   - `outcome`: success/succeeded/ok/true/1 → `success`; fail/failed/false/0/denied → `failure`
   - `product`: synonyms map to the enum (`loan` → `lending`, `casa`/`savings` → `banking`, …)
   - phone: digits only, last 10 digits plus country code; email: lowercase, with Gmail dots and `+tag` removed for the `_norm` copy
5. **Classify each row** into exactly one of these outcomes:
   - **accepted**
   - **rejected** (error): a mandatory field is missing or invalid, or the ID already exists with *different* content (a conflict)
   - **duplicate**: the same ID and the same `row_hash`. It is counted and reported, not re-inserted.
   - **accepted with warning**: orphan references, such as a transaction for an unknown account or a login for an unknown customer
6. **Return**:
   - `{batch_id, type, total, accepted, rejected, duplicates, warnings, errors:[first 200]}`
   - the full error list is a CSV download at `GET /api/batches/:id/errors.csv`
   - every input row is reported in exactly one bucket, so `total` = the sum of the buckets. Assert this in tests.

---

## 5. Detection engine

`run.ts`:
1. Build `DetectionContext` once. It holds:
   - indexes by customer, account, device and application
   - each account's transactions, sorted
   - each customer's login events, sorted
   - account → customer and customer → accounts maps
   - each account's first-seen beneficiary times
2. Run FD-01, FD-02, FD-03 and FD-05, then FD-06 over their output.
3. Score, fingerprint and insert alerts, link them to the run, then build cases.

**Determinism:** all "history" and "age" calculations use data strictly **before the event's own timestamp**, never the wall clock. The same data and policy always produce the same alerts.

Every detector returns `Finding { detector, category, subject, primary_ref, signals[], mitigations[], evidence_refs[], entity sets, products, event_time }`.
- Each signal or mitigation looks like `{ code, label, weight, detail, evidence_refs[] }`.
- `detail` is a human-readable sentence with the actual numbers, for example "₹4,80,000 is 9.6× this account's median (₹50,000) over 41 prior transfers".

### 5.1 Scoring (`score.ts`)
- `raw = Σ signal weights`
- `score = clamp(raw − Σ mitigation weights, 0, 100)`
- **Severity floors** apply after mitigations:
  - an FD-03 chain (failure burst + new device + sensitive action or outbound transfer) is never below 40
  - a confirmed shared payout account across ≥ 3 unrelated customers is never below 40
  - the UI shows "floor applied: …"
- Levels:

| Level | Score | Where it goes |
|---|---|---|
| High | ≥ 70 | Creates a case |
| Medium | 40–69 | Creates a case |
| Low | < 40 | Stored; shown under **Reviewed – not escalated** with its mitigations |

- A finding is stored only if `raw ≥ policy.recordThreshold` (25). Below that it is noise.

All weights and thresholds live in `config/policy.json` (`"version": "1.0.0"`), and the Rules page renders them.

### 5.2 FD-01 Suspicious transfer
Runs over each outgoing transaction (`type` ≠ deposit). Baseline = this account's earlier outgoing transactions.

| Code | Condition | Weight |
|---|---|---|
| HIGH_VALUE | amount ≥ `highValueAbsolute` (₹2,00,000) | +25 |
| AMOUNT_OUTLIER | ≥ 5 prior transfers and robust z = (amt − median) / (1.4826·MAD) > 3.5 and amt > 2 × prior p95 | +30 |
| NO_HISTORY_LARGE | < 5 prior transfers and amount ≥ ₹50,000 | +15 |
| NEW_BENEFICIARY | first transfer from this account to this beneficiary | +15 |
| RAPID_SUCCESSION | ≥ 3 outgoing transfers from this account within 10 minutes | +20 |
| UNUSUAL_CHANNEL | channel accounts for < 5% of ≥ 10 prior transfers | +10 |
| NEW_ACCOUNT | account age < 7 days at the event | +10 |
| DRAIN | outflows in the past 24 h ≥ 80% of inflows in the past 7 days, and inflows ≥ ₹50,000 | +20 |
| PRECEDED_BY_LOGIN_RISK | the owner had, in the previous 60 minutes: ≥ 3 failures, a success on a new device, a `password_reset`, or a `device_change` | +30 |
| MULE_FAN_IN | the beneficiary received from ≥ 3 distinct customers in our data within 72 h | +15 |

| Mitigation | Condition | Weight |
|---|---|---|
| WITHIN_CUSTOMER_NORM | ≥ 10 prior transfers and amount ≤ 1.2 × prior p95 | −25 |
| ESTABLISHED_BENEFICIARY | ≥ 3 prior transfers to this beneficiary | −20 |
| LONG_TENURE | account age > 365 days and PRECEDED_BY_LOGIN_RISK not set | −10 |

A business customer's regular ₹4.5 lakh transfer works out to 25 − 25 − 20 − 10 = 0, so it is Low and lands in Reviewed. The same amount after an account takeover to a new beneficiary works out to 25 + 30 + 15 + 30 (+15) = 100, so it is High.

### 5.3 FD-02 Shared device
Considers each device used by ≥ 2 distinct customers, counting both login events and loan applications.

| Code | Condition | Weight |
|---|---|---|
| DEVICE_SHARED | 2 or more customers | +10 |
| MANY_PROFILES | 3 or more customers; +5 for each extra, max +30 | +15… |
| CLUSTERED_FIRST_USE | every customer's first use of the device falls within 48 h | +20 |
| SHARED_MONEY_TRAIL | two or more of these customers share a payout account or send to the same beneficiary | +25 |
| NEW_PROFILES | all onboarded < 30 days before their first use of the device | +15 |
| UNRELATED_IDENTITIES | no shared surname and no shared normalised address | +10 |

| Mitigation | Condition | Weight |
|---|---|---|
| SAME_HOUSEHOLD | every customer shares a normalised address, or a surname plus city | −25 |
| LONG_STANDING_USE | the device was used by these customers across > 90 days | −15 |
| NO_MONEY_LINK | no shared payout account or beneficiary | −10 |

**A shared IP address on its own is never a signal**, because carrier NAT and office networks share IPs.

- A family of 3 scores 10 + 15 − 50 → 0, so it is Low.
- A ring of 4 scores 10 + 20 + 20 + 25 + 15 + 10 = 100, so it is High.

### 5.4 FD-03 Account takeover (event sequence)
For each customer, take each successful login `S` that has ≥ `failBurst` (3) failures in the 30 minutes before it. Also take bursts of ≥ 3 failures with no success afterwards; those score only FAILED_BURST.

| Code | Condition | Weight |
|---|---|---|
| FAILED_BURST | n failures in 30 minutes; +3 for each failure beyond 3, max +25 | +15… |
| SUCCESS_AFTER_FAILURES | a success follows the burst | +10 |
| NEW_DEVICE | the device on `S` was never used by this customer before | +20 |
| NEW_IP_OR_GEO | the IP or geo on `S` was never seen for this customer | +10 |
| SENSITIVE_ACTION | `password_reset`, `beneficiary_add`, `device_change` or `profile_change` within 60 minutes after `S` | +20 |
| OUTBOUND_AFTER | outgoing transfer within 60 minutes after `S` that is to a new beneficiary or is an FD-01 outlier | +25 |

| Mitigation | Condition | Weight |
|---|---|---|
| KNOWN_DEVICE | the device on `S` was previously used by this customer | −15 |
| NO_FOLLOW_ON | no sensitive action or transfer within 60 minutes | −10 |

- A forgotten password scores 15 + 10 − 15 − 10 = 0, so it is Low.
- A takeover scores 15 + 10 + 20 + 10 + 20 + 25 = 100, so it is High.

### 5.5 FD-05 Loan application ring (the extra scenario)
1. Union-find over applications. Two applications from *different* customers are joined when they share any of:
   - `device_id`
   - normalised phone (from the application or the customer)
   - normalised email
   - `payout_account`
   - `national_id`
2. Each component with ≥ 2 distinct customers becomes one finding.
3. The evidence lists exactly which attribute links each pair.

| Code | Condition | Weight |
|---|---|---|
| SHARED_PAYOUT_ACCOUNT | 2 or more customers share a payout account | +30 |
| SHARED_DEVICE | applications from the same device | +20 |
| SHARED_CONTACT | the same phone or email under different customers | +20 |
| ID_REUSE | the same `national_id` with a different name or DOB (synthetic identity) | +30 |
| APPLICATION_VELOCITY | 3 or more applications in the component within 7 days | +15 |
| NEW_PROFILES | applicants onboarded < 30 days before applying | +10 |

| Mitigation | Condition | Weight |
|---|---|---|
| SAME_HOUSEHOLD | all applicants share an address or a surname, and there is no shared payout account and no ID_REUSE | −25 |

### 5.6 FD-06 Cross-system correlation (differentiator)
1. Each Medium+ finding from FD-01/02/03/05 has an entity set: customers, accounts, devices, applications and beneficiary accounts.
2. **Hub exclusion:** drop any entity linked to more than `hubDegree` (20) distinct customers, such as merchants and utilities, so components don't merge through them.
3. Union-find over the findings: two findings join when their entity sets overlap.
4. Each component that contains findings from **≥ 2 different detectors** becomes one FD-06 finding:
   - `score = max(member scores) + 10 × (distinct detectors − 1) + 10` if the component spans ≥ 2 products; cap at 100
   - signals list each member finding ("Loan ring APP-… (FD-05, 95)", …) and each **bridging entity** ("Account M-… receives the loan payouts *and* the ATO transfer")
   - the evidence is the union of the members' evidence, plus a merged timeline

### 5.7 Case building (`cases.ts`)
- One case per FD-06 finding, containing it and all its member alerts.
  - Category: `Cross-system organised fraud`.
  - Level: the highest among its members.
- One case for each remaining Medium+ alert that is in no FD-06 component.
- Categories:
  - FD-01: Suspicious transfer
  - FD-02: Coordinated device use
  - FD-03: Account takeover
  - FD-05: Loan application fraud
- The primary customer/account is the one that appears in most of the evidence.

---

## 6. API (route handlers)

| Method & path | Purpose |
|---|---|
| `POST /api/ingest` | multipart `file` + optional `type`, returns the batch result (§4.6) |
| `GET /api/samples` | lists bundled sample sets |
| `POST /api/samples/load` | `{seed}` ingests every file of a bundled sample through the same pipeline |
| `GET /api/batches` / `GET /api/batches/:id/errors.csv` | import history / error report |
| `POST /api/detect` | runs detection, returns `{run_id, new_alerts, total_alerts, cases_created, by_level, by_detector, ms}` |
| `GET /api/policy` | current policy JSON |
| `GET /api/alerts` | filters: `customer`, `transaction`, `product`, `level`, `detector`, `from`, `to`, `view=escalated\|reviewed\|all`, `q`. Uses the latest run. Filters on ID lists use `json_each`. |
| `GET /api/alerts/:id` | the alert plus the **resolved evidence rows** (with `source_file`/`source_row`), the primary event, and linked case IDs |
| `GET /api/cases` | filters: `status`, `level`, `category`, `customer` |
| `GET /api/cases/:id` | the case, a frozen view of each member alert, the decision history, and a merged timeline |
| `POST /api/cases/:id/decisions` | `{decision, note, analyst, revised_level?, revised_category?}`, appended. The note is required for FALSE_POSITIVE and DISMISSED. |
| `GET /api/customers/:id` | profile, accounts, devices, applications, alerts, and a chronological timeline |
| `GET /api/dashboard` | record counts by type and batch, accepted/rejected, alerts by level, detector and product, open cases, the 10 most recent High alerts |
| `POST /api/evaluate` | body is a `ground_truth.json`; returns results per scenario (§8) |
| `POST /api/reset` | clears the workspace (confirmation required in the UI) |

Every handler validates its input with zod and returns `{error, details}` with status 400 or 404. No stack traces reach the client.

---

## 7. Screens

1. **Dashboard (`/`)**
   - KPI tiles: records processed (by type), rejected rows, flagged events, open cases
   - Risk distribution bar (High, Medium, Low)
   - Alerts by fraud category; alerts by product
   - Recent High alerts table
   - "Run detection" button, which shows the last run time and policy version
   - Empty state: "Load sample data or upload files" with a link to Ingest
2. **Ingest (`/ingest`)**
   - **Select:** a sample-seed dropdown and a "Load sample" button
   - **Upload:** a drag-and-drop zone for multiple files, with an optional type override
   - Each file gets a result card showing:
     - the detected type and the header mapping as `source → field`
     - counts as colour-coded badges
     - the first errors in a table (row, field, message), with a link to the full CSV
   - Import history table below
3. **Alerts (`/alerts`)**
   - Tabs: **Escalated** (Medium/High) | **Reviewed – not escalated** (Low) | All
   - Filter bar: customer, transaction ID, product, level, detector, date range
   - Table: level badge, score, detector, subject, products, event time, top reason
   - Clicking a row opens the detail view.
4. **Alert detail (`/alerts/[id]`)**
   - The primary event (raw record)
   - A **Why flagged** table listing signals (+) and mitigations (−) with weights, the detail sentence, and an evidence link for each
   - Score working: raw − mitigations → score, plus the floor note if one applied
   - Supporting records, grouped by table, with `source_file:row`
   - Links to the linked case and to each customer
5. **Customer investigation (`/customers/[id]`)**
   - Profile
   - Linked devices, showing the other customers on each device
   - Accounts, applications, alerts
   - **Unified timeline** across logins, transactions and loans, with flagged events highlighted
   - Optional Cytoscape mini-graph
6. **Cases (`/cases`, `/cases/[id]`)**
   - The queue sorts by level and then age, and has a status filter.
   - The case page shows:
     - header: ID, primary customer/account, category, original level, current status
     - member alerts (read-only, with an "Original alert – immutable" label)
     - the merged timeline
     - the decision form: decision, note, optional revised level and category
     - the decision history (who, when, what changed)
7. **Rules (`/rules`)**: the policy rendered as tables of detector, signal, weight and threshold, plus the policy version.
8. **Evaluation (`/evaluation`)**: upload `ground_truth.json` to see pass/fail per scenario, precision, recall, the lookalike false-positive rate, and detection time.

---

## 8. Synthetic data generator (`scripts/generate.ts --seed N --out data/samples/seed-N`)

The generator uses a seeded PRNG (mulberry32) with small Indian name, city and street lists, and no faker dependency. Time base: data spans 2026-07-01 → 2026-10-15, with every time derived from the seed.

**Background population:** 300 customers.
- About 1.3 accounts each; products split roughly banking 70%, cards 15%, lending 10%, insurance 5%.
- About 3,000 transactions with log-normal amounts and recurring beneficiaries per customer.
- About 1,500 logins, mostly from known devices, with occasional single failures.
- About 120 legitimate loan applications.

**Planted scenarios.** IDs, amounts and times are randomised per seed.

| ID | Scenario | Construction | Expected |
|---|---|---|---|
| S1 ×2 | Account takeover | established customer (≥ 20 prior transfers, per-customer log-normal σ ≤ 0.6); 5 failures from a new device and IP in 8 min → success on that device → `beneficiary_add` → transfer of **≥ 3× prior p95** to a new beneficiary within 15 min | FD-03 High (≈100), FD-01 High (≈75) |
| S2 | Amount outlier | ≥ 10 prior transfers; amount **≥ ₹2 lakh and ≥ 3× prior p95** to a new beneficiary; no login anomaly | FD-01 Medium (30+25+15−10 = 60) |
| S3 | Rapid transfers | account aged **60–300 days**; 4 transfers to new beneficiaries in 6 minutes through a rarely used channel (`api`) | FD-01 Medium (15+20+10 = 45) on transfers 3 and 4 |
| S4 | New account drain | account aged 3 days receives ₹3 lakh, then sends 95% out within 24 h | FD-01 High (≈85) |
| S5 | Loan ring | 4 new customers with unrelated names and addresses, onboarded within 3 days; applications from one device within 48 h; 3 share a payout account `P`, which is a **new account** opened by one ring member; disbursements (with `application_id`) land in `P`; within 24 h `P` sends **≥ 80%** to beneficiary `M` | FD-05 High, FD-02 High, FD-01 High on the transfer from `P` to `M` |
| S6 | Cross-system chain | one S1 takeover transfer goes to the same `M` as S5. The chain links FD-05 (`P`), FD-01 (`P`→`M`), FD-01 (victim→`M`) and FD-03 (victim). | FD-06 High, merging FD-03 + FD-01 + FD-05 + FD-02 into one case |
| L1 ×2 | Family device (lookalike) | 3 customers with the same surname and address, customers for > 1 year, sharing a tablet across 120 days, separate payout accounts, normal amounts | FD-02 **Low** only |
| L2 ×3 | High-value business (lookalike) | routine ₹2–5 lakh transfers to established beneficiaries, then one more | **no** Medium+ FD-01 |
| L3 | Forgotten password (lookalike) | 4 failures → success on a known device → nothing else | FD-03 **Low** only |
| L4 | New phone (lookalike) | a customer's first-try success on a new device, then normal activity | no alert |

**Outputs**, per seed:
- `customers.csv`, `accounts.csv`, `transactions.csv`, `login_events.csv`, `loan_applications.csv`
- the same data as `tracex.xlsx` (one sheet per type)
- `tracex.json` (one keyed object)
- `transactions_with_errors.csv`, containing 5 deliberate bad rows:
  - missing `transaction_id`
  - unparseable date
  - negative amount
  - unknown account (warning)
  - existing ID with different values (conflict)
- `logins_alt_headers.csv`, which uses alias headers to demonstrate mapping
- `ground_truth.json`: `[{scenario, kind: fraud|lookalike, detector, expected_level | max_level, entities:{customer_ids, account_ids, …}}]`

**The app never reads `ground_truth.json` during detection.** Only `/api/evaluate` reads it, and only when the user uploads it.

Seeds 1, 2 and 3 are generated and committed. Tests run on all three.

---

## 9. Tests (vitest), which double as the acceptance suite

**Ingestion**
- Alias headers map correctly.
- Each bad row lands in the right bucket with the right field and message.
- `total = accepted + rejected + duplicates`.
- A second upload of the same file gives accepted = 0 and duplicates = n.
- CSV, XLSX and JSON imports of the same seed produce identical DB row counts.

**Detection, for each seed in 1–3:**
- Every `fraud` ground-truth item is matched by an alert from the expected detector at or above the expected level, and that alert includes the item's entities.
- Every `lookalike` item has **no** alert above its `max_level`.
- One FD-06 case contains S5 and S6.

**Integrity**
- Running detection twice gives 0 new alerts and 0 new cases.
- `UPDATE alerts …` throws.
- Recording a FALSE_POSITIVE decision leaves the alert row byte-identical, and the case status becomes FALSE_POSITIVE.
- Every `evidence_ref` resolves to an existing row.

**Detector mechanics**
- Removing S6's bridging transfer and re-running drops the FD-06 finding, but the FD-03 alert is still High. This proves the multi-signal reasoning.

---

## 10. Build order (3 hours)

| Time | Step | Done when |
|---|---|---|
| 0:00–0:15 | `create-next-app`, Tailwind/shadcn, Drizzle + libSQL, schema + triggers, `policy.json` | `npm run db:push` creates the tables and the triggers fire |
| 0:15–0:35 | `generate.ts` covering every §8 scenario; commit seeds 1–3 | Files and ground truth exist for 3 seeds |
| 0:35–1:00 | Ingest: aliases, parse ×3, zod, buckets, `/api/ingest`, `/api/samples/load` | Ingestion tests pass |
| 1:00–1:50 | `context.ts`, FD-01/02/03/05, `score.ts`, FD-06, `cases.ts`, `/api/detect` | Detection and integrity tests pass on seeds 1–3 |
| 1:50–2:35 | Screens: Dashboard → Ingest → Alerts + detail → Cases + decision → Customer timeline → Rules | Manual run of §11 steps 1–6 works |
| 2:35–2:50 | Evaluation page, README + KNOWN_LIMITATIONS, deploy to Vercel + Turso | The deployed URL passes §11 |
| 2:50–3:00 | Rehearse the demo on **seed 3**, which has not been looked at | |

### Sprints (tracked in `SPRINTS.xlsx`, one commit per sprint)

| Sprint | Goal | Timebox |
|---|---|---|
| S0 | Repo, plan and tracker | 10 min |
| S1 | Scaffold: Next.js, DB schema, triggers, policy, utilities | 20 min |
| S2 | Synthetic data generator + committed seeds 1–3 | 25 min |
| S3 | Ingestion pipeline + APIs + tests | 25 min |
| S4 | Detection engine FD-01/02/03/05/06, scoring, cases + tests | 50 min |
| S5 | UI part 1: Dashboard, Ingest, Alerts list + detail | 30 min |
| S6 | UI part 2: Cases + decisions, Customer timeline, Rules, Evaluation | 30 min |
| S7 | Hardening, README/limitations, deploy, demo rehearsal | 20 min |

Tasks per sprint live on the `Tasks` sheet. Update the tracker with `python tools/tracker.py task T4.2 Done <commit>`; it edits cells in place, so changes made by hand in Excel are kept.

If time slips, cut in this order: the Cytoscape graph, the Evaluation page, the Rules page (keep `policy.json`), the alias demo file.
**Never cut:** validation buckets, lookalike mitigations, the explanation table, decision persistence, immutability.

---

## 11. Acceptance run and demo script (about 4 minutes)

1. **Reset** the workspace. **Load sample seed 3** and show the counts.
2. **Upload** `transactions_with_errors.csv`. Show 5 rows reported with reasons, then upload it again to show the duplicates counted rather than re-inserted.
3. **Upload** `logins_alt_headers.csv` to show the header mapping.
4. **Run detection.** Show the dashboard counts, risk distribution, categories and products.
5. **Open the cross-system case.** Walk through it: the loan ring shares a device and payout account → the money flows to `M` → an account takeover elsewhere also pays `M`. Use the timeline and the source rows.
6. **Open Reviewed – not escalated:**
   - the family device, with the household mitigation shown
   - the business customer's large transfer, with the within-norm and established-beneficiary mitigations
   - the forgotten password
7. **Filter** the alerts by product = lending, then by a specific customer.
8. **Decide:** mark one case Requires Investigation and another False Positive with a note. **Refresh** the page: the status persists and the original alert is still shown unchanged.
9. **Re-run detection** to show 0 new alerts and 0 new cases.

---

## 12. After Level 1 (only once §9 is green)

- **Duplicate insurance claims:** a `claims` table, plus a detector for the same incident, document hash or bank account across policies.
- **Evidence-grounded case narrative:** an LLM summarises only the stored evidence, with a deterministic template as fallback.
- Analyst assignment, SLA timers and an escalation workflow.
- Policy editing in the UI, with versioning.
- An Isolation Forest or other ML score as one more weighted signal, never on its own.

## References
- Feedzai Bank Account Fraud dataset suite (NeurIPS 2022), for an optional offline sanity check of identity signals: https://github.com/feedzai/bank-account-fraud
- SheetJS CVE-2023-30533 (npm `xlsx` ≤ 0.19.2): https://git.sheetjs.com/sheetjs/sheetjs/issues/3012
