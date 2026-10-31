// Every source row carries provenance so any alert can point back to file + row.
const PROVENANCE = `
  batch_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  row_hash TEXT NOT NULL`;

export const TABLES = [
  "agent_actions", "agent_feedback", "agent_assessments", "case_actions", "case_splits", "case_alert_moves",
  "case_decisions", "case_alerts", "cases", "run_alerts", "alerts", "detection_runs",
  "import_errors", "import_batches",
  "insurance_claims", "loan_applications", "login_events", "transactions", "accounts", "customers",
];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  dob TEXT,
  national_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  onboarding_date TEXT,
  onboarding_channel TEXT,
  kyc_status TEXT,
  occupation TEXT,
  declared_income REAL,
  name_norm TEXT,
  surname TEXT,
  phone_norm TEXT,
  email_norm TEXT,
  address_norm TEXT,${PROVENANCE}
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product TEXT NOT NULL,
  account_type TEXT,
  opened_at TEXT NOT NULL,
  status TEXT,${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_accounts_customer ON accounts(customer_id);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  beneficiary_account TEXT NOT NULL,
  beneficiary_name TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  amount_inr REAL,
  timestamp TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  type TEXT,
  application_id TEXT,${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_txn_beneficiary ON transactions(beneficiary_account);

CREATE TABLE IF NOT EXISTS login_events (
  event_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  device_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  geo TEXT,
  timestamp TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'login',${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_login_customer ON login_events(customer_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_login_device ON login_events(device_id);

CREATE TABLE IF NOT EXISTS loan_applications (
  application_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  device_id TEXT,
  phone TEXT,
  email TEXT,
  phone_norm TEXT,
  email_norm TEXT,
  requested_amount REAL NOT NULL,
  payout_account TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status TEXT,
  declared_income REAL,
  employer TEXT,
  loan_purpose TEXT,${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_loan_customer ON loan_applications(customer_id);

CREATE TABLE IF NOT EXISTS insurance_claims (
  claim_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  incident_date TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  claim_amount REAL NOT NULL,
  sum_insured REAL,
  policy_start_date TEXT,
  provider_id TEXT,
  payout_account TEXT NOT NULL,
  device_id TEXT,
  document_hash TEXT,
  status TEXT,
  description TEXT,${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_claims_customer ON insurance_claims(customer_id);

CREATE TABLE IF NOT EXISTS workspace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  dataset_type TEXT NOT NULL,
  format TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  warnings INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  field TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('error','warning','duplicate')),
  message TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_errors_batch ON import_errors(batch_id);

CREATE TABLE IF NOT EXISTS detection_runs (
  run_id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  counts_json TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  first_run_id TEXT NOT NULL,
  detector TEXT NOT NULL,
  category TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL,
  customer_ids TEXT NOT NULL,
  account_ids TEXT NOT NULL,
  transaction_ids TEXT NOT NULL,
  device_ids TEXT NOT NULL,
  application_ids TEXT NOT NULL,
  claim_ids TEXT NOT NULL DEFAULT '[]',
  products TEXT NOT NULL,
  event_time TEXT NOT NULL,
  primary_ref TEXT NOT NULL,
  raw_score INTEGER NOT NULL,
  score INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('High','Medium','Low')),
  floor_note TEXT,
  signals_json TEXT NOT NULL,
  mitigations_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  member_alert_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_detector ON alerts(detector);
CREATE INDEX IF NOT EXISTS idx_alerts_event_time ON alerts(event_time);

CREATE TABLE IF NOT EXISTS run_alerts (
  run_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  PRIMARY KEY (run_id, alert_id)
);

CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL UNIQUE,
  first_run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  primary_customer_id TEXT,
  primary_account_id TEXT,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_alerts (
  case_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  PRIMARY KEY (case_id, alert_id)
);

CREATE TABLE IF NOT EXISTS case_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('REQUIRES_INVESTIGATION','ESCALATED','FALSE_POSITIVE','DISMISSED')),
  note TEXT,
  analyst TEXT NOT NULL,
  revised_level TEXT CHECK (revised_level IS NULL OR revised_level IN ('High','Medium','Low')),
  revised_category TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_decisions_case ON case_decisions(case_id, id);

-- Original alerts, cases and decisions can never be changed or removed.
-- Only "reset workspace" (which drops the tables) clears them.
CREATE TRIGGER IF NOT EXISTS alerts_no_update BEFORE UPDATE ON alerts
BEGIN SELECT RAISE(ABORT, 'alerts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS alerts_no_delete BEFORE DELETE ON alerts
BEGIN SELECT RAISE(ABORT, 'alerts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS cases_no_update BEFORE UPDATE ON cases
BEGIN SELECT RAISE(ABORT, 'cases are immutable; record a decision instead'); END;
CREATE TRIGGER IF NOT EXISTS cases_no_delete BEFORE DELETE ON cases
BEGIN SELECT RAISE(ABORT, 'cases are immutable'); END;
CREATE TRIGGER IF NOT EXISTS case_decisions_no_update BEFORE UPDATE ON case_decisions
BEGIN SELECT RAISE(ABORT, 'case decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_decisions_no_delete BEFORE DELETE ON case_decisions
BEGIN SELECT RAISE(ABORT, 'case decisions are append-only'); END;

-- Level 2: analyst workflow actions, case splits and the agent's assessments, feedback and autonomous actions.
CREATE TABLE IF NOT EXISTS case_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  ref_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_actions_case ON case_actions(case_id, id);

CREATE TABLE IF NOT EXISTS case_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_case_id TEXT NOT NULL,
  to_case_id TEXT NOT NULL,
  moved_alert_ids TEXT NOT NULL,
  moved_fingerprints TEXT NOT NULL,
  kept_fingerprints TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_alert_moves (
  alert_id TEXT NOT NULL,
  from_case_id TEXT NOT NULL,
  to_case_id TEXT NOT NULL,
  split_id INTEGER NOT NULL,
  PRIMARY KEY (alert_id, from_case_id)
);

CREATE TABLE IF NOT EXISTS agent_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  predicted_category TEXT NOT NULL,
  confidence REAL NOT NULL,
  grounding REAL NOT NULL,
  assessment_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_assessments_case ON agent_assessments(case_id, id);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  predicted_category TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','corrected','rejected')),
  corrected_category TEXT,
  reasoning TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  grounding REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'analyst',
  split TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_cat ON agent_feedback(predicted_category, id);

CREATE TABLE IF NOT EXISTS agent_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  autonomy_level INTEGER NOT NULL,
  detail TEXT,
  reversible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS case_actions_no_update BEFORE UPDATE ON case_actions
BEGIN SELECT RAISE(ABORT, 'case actions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_actions_no_delete BEFORE DELETE ON case_actions
BEGIN SELECT RAISE(ABORT, 'case actions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_splits_no_update BEFORE UPDATE ON case_splits
BEGIN SELECT RAISE(ABORT, 'case splits are append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_splits_no_delete BEFORE DELETE ON case_splits
BEGIN SELECT RAISE(ABORT, 'case splits are append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_assessments_no_update BEFORE UPDATE ON agent_assessments
BEGIN SELECT RAISE(ABORT, 'agent assessments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_feedback_no_update BEFORE UPDATE ON agent_feedback
BEGIN SELECT RAISE(ABORT, 'agent feedback is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_feedback_no_delete BEFORE DELETE ON agent_feedback
BEGIN SELECT RAISE(ABORT, 'agent feedback is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_no_update BEFORE UPDATE ON agent_actions
BEGIN SELECT RAISE(ABORT, 'agent action log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_no_delete BEFORE DELETE ON agent_actions
BEGIN SELECT RAISE(ABORT, 'agent action log is append-only'); END;

-- Alerts currently belonging to a case: the original grouping minus alerts an analyst moved out.
CREATE VIEW IF NOT EXISTS case_alerts_effective AS
SELECT ca.case_id, ca.alert_id FROM case_alerts ca
WHERE NOT EXISTS (SELECT 1 FROM case_alert_moves m WHERE m.alert_id = ca.alert_id AND m.from_case_id = ca.case_id);

-- Settings survive a workspace reset (kill switch, autonomy thresholds).
CREATE TABLE IF NOT EXISTS agent_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

/** Columns added after the first release; applied to existing databases, ignored when already present. */
export const MIGRATIONS = [
  "ALTER TABLE customers ADD COLUMN occupation TEXT",
  "ALTER TABLE customers ADD COLUMN declared_income REAL",
  "ALTER TABLE loan_applications ADD COLUMN declared_income REAL",
  "ALTER TABLE loan_applications ADD COLUMN employer TEXT",
  "ALTER TABLE loan_applications ADD COLUMN loan_purpose TEXT",
  "ALTER TABLE alerts ADD COLUMN claim_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE transactions ADD COLUMN amount_inr REAL",
  "ALTER TABLE login_events ADD COLUMN user_agent TEXT",
];
