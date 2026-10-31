# TRACE X

**Cross-system digital fraud detection and investigation.** Azentio AI Hackathon, Challenge #01 (Digital Fraud Investigation System), Level 1.

**Live demo:** https://trace-x-rouge-rho.vercel.app

| Sign in as | Password | Role |
|---|---|---|
| `test@agentio.com` | `agentio@123` | Analyst: import, detect, investigate, decide |
| `thanushgarimella@gmail.com` | `agentio@123` | Admin: everything, including workspace reset |

The live workspace starts with sample seed 3 loaded and detected. All accounts share one workspace.

TRACE X brings customer, account, transaction, device/login, loan-application and insurance-claim data into one linked model. It detects fraud that looks normal inside any single system. Every score is explained by weighted signals and the records behind them. Legitimate lookalikes are kept out of the case queue. Every analyst decision is recorded without changing the original alert.

## What it does

| Capability | Where |
|---|---|
| Upload or select CSV, Excel (multi-sheet) and JSON; header aliases; per-row validation where every row is accepted, rejected, a duplicate, or accepted with a warning, never dropped | **Data ingestion** (`/ingest`) |
| Detectors: FD-01 suspicious transfer, FD-02 shared device, FD-03 account takeover (failed-login bursts *and* phished sessions with no failures), FD-04 identity / synthetic profiles (shared national ID, phone or email; implausible attributes), FD-05 loan-application ring (including stated income far above the profile), FD-07 insurance-claim fraud (duplicate documents or incidents, early claims, near-sum-insured, late reporting, shared payout accounts, provider clustering), FD-08 dormant-account reactivation (mule pass-through), FD-06 cross-system correlation, plus legitimate-lookalike handling inside each |
| Unsupervised ML: a seeded Isolation Forest over 14 behavioural features (including deviation from the customer's usual local hour, beneficiary in-degree, gap vs usual gap, amount vs declared income). The top 0.2% add a corroborating `ML_ANOMALY` signal; the top 0.5% that no rule caught are kept as Low FD-ML "model-only" findings | `lib/detect/anomaly.ts`, `fdml-model-only.ts` |
| Investigation brief on every case: a five-line summary and next checks, generated from stored evidence with every line citing record IDs (deterministic; no external model) | Case page |
| Learning from analyst decisions: a logistic regression on decided cases suggests weight changes per signal; it never edits the policy | **Rules** (`/rules`) | `lib/detect/`, rules on **Rules** (`/rules`) |
| Risk score 0–100 (High ≥ 70, Medium 40–69, Low < 40) = risk signals − legitimate context, with severity floors | Alert detail → "Why it was flagged" |
| Command center: clickable KPIs, alerts over time, risk distribution, priority investigations, fraud categories, products, records by source system | **Command center** (`/`) |
| Alert filters: customer, transaction, product, risk level, date range, detection type and actual case status; separate Actionable-risk and Monitored-signal views | **Alerts** (`/alerts`) |
| Case queue: alerts sharing an entity grouped into one case; decisions Requires investigation / Escalate / False positive / Dismiss, with optional reclassification | **Cases** (`/cases`) |
| Customer intelligence: searchable index, plus per customer the devices and who else used them, accounts, loans, claims and a unified timeline | **Customers** (`/customers`) |
| Evaluation against a ground-truth answer key (recall, lookalike false-positive rate, precision), including a side-by-side fraud-vs-lookalike explanation and an unseen holdout seed | **Evaluation** (`/evaluation`) |
| Signed sessions with analyst/admin roles on every page and API; mutations require either role and workspace reset is admin-only | Sign-in + server-side route guards |

### How the scoring stays honest

- **Signals and mitigations.** Each detector adds weighted risk signals and subtracts legitimate context: within the customer's usual range, an established beneficiary, the same household, long-standing device use, a known device. All weights live in [`config/policy.json`](config/policy.json).
- **Baselines are per customer and look only backwards.** "Unusual" means unusual *for this account*, measured on data before the event (excluding the previous 24 h). The same data and policy always give the same result.
- **Hubs are excluded.** Merchants, utilities and kiosk devices used by more than 20 customers never link unrelated people or count as a "new beneficiary".
- **Floors.** Mitigations cannot pull a full takeover chain, or a payout account shared by three or more unrelated people, below Medium.
- **Immutable history.** SQLite triggers block every `UPDATE`/`DELETE` on alerts, cases and decisions. Alert IDs come from their evidence, so re-running detection never duplicates anything.

## Run locally

Requires Node.js 22+.

```bash
npm install
npm run dev            # http://localhost:3000 (data stored in ./tracex.db)
```

Then:
1. Sign in as `test@agentio.com` / `agentio@123` (analyst), or `thanushgarimella@gmail.com` / `agentio@123` (admin, needed for workspace reset).
2. **Data ingestion**: pick *Seed 3* and choose **Load sample**, or upload files.
3. **Run detection**.
4. Open the cross-system case.

Other scripts:

```bash
npm test               # 59 vitest tests: ingestion and unseen-data robustness, detectors on 3 seeds + holdout seed 101, ML, evidence integrity, sessions, case workflow, brief, learning
npm run typecheck
npm run gen:all        # regenerate data/samples/seed-{1,2,3}
npm run smoke -- http://localhost:3000 3   # end-to-end API check (RESETS the workspace)
```

Environment (all optional locally; see `.env.example`):

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Use a hosted libSQL/Turso database (required on Vercel, whose filesystem is not persistent) |
| `TRACEX_DB_URL` | Override the local database URL (default `file:tracex.db`; tests use `:memory:`) |
| `TRACEX_USERS` | Replace the built-in accounts with a JSON array of `{username,password,name,role}`; `password` may be plain or `scrypt:<salt>:<hash>` |
| `TRACEX_SESSION_SECRET` | HMAC key for signed session cookies; required for a shared deployment |

## Sample data

`data/samples/seed-N/` holds linked synthetic data (≈ 330 customers, 4.6k transactions, 4.1k login events, 124 loan applications, 40–55 insurance claims) with planted scenarios. Each seed changes IDs, amounts, dates and entity relationships. Seeds 1–3 are demonstration sets; lean seed 101 is the separately generated holdout set. See [`data/samples/README.md`](data/samples/README.md).

| Planted | Expected |
|---|---|
| S1 / S6 account takeover: 5 failures → new-device success → beneficiary added → large transfer | FD-03 High, FD-01 High |
| S2 amount outlier, S3 rapid transfers via a rare channel, S4 new account drained | FD-01 Medium / Medium / High |
| S5 loan ring: 4 new unrelated applicants, one device, shared payout account, proceeds forwarded to a mule | FD-05, FD-02, FD-01 High |
| S6 the takeover pays the same mule | FD-06 High: one case linking the ring, the takeover and the shared identity |
| S7 synthetic identities: one national ID under two names, a reused email, an applicant aged 16 | FD-04 High |
| S9 two new motor policies claim on the same garage invoice, paid into the loan ring's account | FD-07 High; insurance joins the FD-06 case |
| S11 dormant account (silent since March) receives ₹2.5 lakh and passes 95% to new payees within hours | FD-08 High |
| S10 one hospital stay claimed on an old policy and on a second policy bought days earlier | FD-07 Medium |
| S8 phished credentials: password reset from a new device in another city, new beneficiary, large transfer, no failed logins | FD-03 High, FD-01 High |
| L1 family tablet, L2 routine ₹4.5 lakh business payments, L3 forgotten password, L4 new phone, L5 couple sharing a home phone, L6 wife's claim paid to her husband's account, L7 salary account resuming after a sabbatical | Low or no alert |

Measured on seeds 1–3 and holdout seed 101: **18/18 planted fraud detected, 10/10 lookalikes kept Low**, 91–96% of Medium/High alerts on planted entities. These numbers come from synthetic data and are not validated real-world accuracy.

### Data fields used for classification

Beyond the mandatory identifiers, the model keeps fields that the detectors score on:
- **Customers:** date of birth, national ID, address, city, occupation, declared income, onboarding date and channel.
- **Loan applications:** device, phone, email, stated income, employer, loan purpose.
- **Insurance claims:** policy, claim type, incident date, submission date, sum insured, policy start date, provider (hospital or garage), payout account, device, document hash.

Optional fields that are missing are simply not scored. A value that cannot be read is stored as empty with a warning.

## Architecture

```
Next.js 16 (App Router, TypeScript) ─ one app, server components + route handlers
  lib/ingest   parse (Papa Parse, SheetJS 0.20.3 from cdn.sheetjs.com) → header aliases → validation → buckets
  lib/detect   context (indexes, baselines) → FD-01/02/03/04/05/07 → score → correlate → FD-06 → cases
  lib/db       libSQL (local SQLite file or Turso); schema + immutability triggers
  app/api      ingest, samples, batches, detect, alerts, cases, decisions, customers, evaluate, policy, reset
```

## API

| Method | Path | |
|---|---|---|
| POST | `/api/ingest` | multipart `file` (repeatable), optional `type` |
| GET/POST | `/api/samples`, `/api/samples/load` | list or download bundled files; `{seed}` loads one |
| GET | `/api/batches`, `/api/batches/:id/errors` | import history; full issue report as CSV |
| POST | `/api/detect` | run detection; returns counts, new alerts and cases, timing |
| GET | `/api/alerts?customer=&transaction=&product=&level=&detector=&case_status=&from=&to=&view=` | filtered alerts (latest run); view is `actionable`, `monitored` or `all` |
| GET | `/api/alerts/:id` | alert, resolved evidence rows, linked cases |
| GET | `/api/cases`, `/api/cases/:id` | queue; case with alerts, timeline, decisions |
| GET/POST | `/api/cases/:id/decisions` | history; append `{decision, note, revised_level?, revised_category?}`; analyst identity comes from the signed session |
| GET | `/api/customers/:id`, `/api/dashboard`, `/api/policy` | |
| POST | `/api/evaluate` | `{seed}` or a ground-truth JSON body |
| POST | `/api/reset` | admin-only; `{confirm: "RESET"}` deletes everything (demo only) |

Project planning lives in [`PLAN.md`](PLAN.md) and [`SPRINTS.xlsx`](SPRINTS.xlsx) (update the tracker with `python3 tools/tracker.py`). Limitations are listed in [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

## Level 2: investigation platform, learned models and an agent team

### What makes TRACE X different
1. **Data most fraud demos do not have.** Ingestion accepts the session telemetry banks already collect from their mobile SDKs and switches: SIM-swap age, remote-access/screen-share tool, emulator or rooted device, VPN/proxy, session length and a behavioural-biometric anomaly score. It also accepts the verify-payee (beneficiary name check) result that RBI's 2025 rules made available for RTGS/NEFT and NPCI's lookup for UPI/IMPS. These are optional columns with header aliases. They feed both the takeover/transfer rules and the graph model, and when a column is absent everything still works.
2. **Three independent opinions, kept separate.** Explainable rules (FD-01..FD-08), an isolation forest on transfers, and a graph neural network on the customer graph. Disagreement is visible, not averaged away.
3. **An agent team that cannot make things up.** The LLM agents propose; code checks every cited ID against the database and drops what it cannot find. The SQL agent sees only source tables, never the human decisions it is graded against.
4. **Autonomy is earned, per fraud category, and can be revoked.** It uses a Beta-Binomial lower bound with a held-out split and a kill switch. Customer-impacting actions are never autonomous.

### Graph neural network (`lib/ml`, `scripts/train-model.ts`, `config/model.json`, `docs/MODEL_CARD.md`)
- 26 per-customer features from raw records (no detector output, no labels), on a customer graph built from shared device, phone, email, national ID, payout/beneficiary account and invoice (hubs excluded).
- SIGN-style propagation (own, 1-hop, 2-hop neighbourhood features, Kipf-Welling normalisation) feeding an MLP trained with Adam. Logistic regression with and without graph features are kept as baselines.
- **Split by dataset:** train seeds 1–3, validation seed 101 (model choice and threshold), **sealed test seeds 201 and 202** (reported once). Results and the ablation without the enriched fields are in the model card and on the Evaluation page.
- At detection time every customer is scored. Customers above the validated threshold with no actionable rule alert become Low **FD-GNN** monitored findings, with drivers (occlusion) and graph neighbours as the explanation.

### Agent team (`lib/agent/multi.ts`, `sql-guard.ts`, `learn.ts`)
Orchestrator → hypothesis agent → SQL agent (read-only, single statement, table allow-list, row cap, one self-repair round) → reviewer agent (verdicts, investigation score, recommended actions) → **code verification**. A "supported" verdict with no verified citation is downgraded. The feedback-learning agent compares each assessment with the analyst's verdict and writes a reusable lesson. Lessons are retrieved into later prompts with the same detector signature, and only training-split cases create them. Without `OPENAI_API_KEY`, or on any model error, the deterministic tool agent runs instead and says so. Sealed-seed accuracy is in `docs/AGENT_EVAL.md`.

### Level 2 requirements map
| Requirement | Where |
|---|---|
| Cross-system correlation (customer, account/beneficiary, device, IP, phone, loan application, transaction, policy, claim; time window; hub attenuation) | `lib/detect/fd06-cross-system.ts` |
| Relationship graph (Cytoscape, evidence on every edge, filters, graph → timeline/source record, node size = GNN probability) | `lib/graph.ts`, `components/case-graph.tsx`, `/graph` |
| Consolidation explanation and analyst split (persists across re-runs) | `lib/consolidation.ts` |
| Workspace actions, supervisor approvals, notes, conclusion, immutable history | `lib/actions.ts` |
| PDF / JSON case report with resolved references | `lib/report.ts`, `lib/pdf.ts` |
| Separate risk, confidence, exposure, priority, agent trust; "Needs More Evidence" | `lib/priority.ts` |
| Per-category trust, L0–L3, kill switch, autonomous allowlist | `lib/agent/trust.ts`, `lib/agent/store.ts`, `/agent` |

### Commands
- `npm test`: unit and integration tests on in-memory databases.
- `npx tsx scripts/train-model.ts`: retrains the graph model and rewrites the model card.
- `OPENAI_API_KEY=... npx tsx scripts/eval-agent.ts`: agent accuracy on the sealed seeds.
- `node scripts/smoke-l2.mjs http://localhost:3000 3`: end-to-end check against a local server on its own database.

### Limitations
Synthetic data with planted scenarios: the held-out numbers show the methods generalise across datasets, not real-world accuracy. The GNN uses fixed (not learned) propagation, a deliberate choice for small graphs and CPU-only serverless. LLM output varies run to run; verification bounds what reaches the screen but cannot make the reasoning deterministic. Trust needs many human decisions per category before L2/L3. The answer-key replay is a labelled simulated analyst for demos.
