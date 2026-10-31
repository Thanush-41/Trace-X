// Every source row carries provenance so any alert can point back to file + row.
const PROVENANCE = `
  batch_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  row_hash TEXT NOT NULL`;

export const TABLES = [
  "case_decisions", "case_alerts", "cases", "run_alerts", "alerts", "detection_runs",
  "import_errors", "import_batches",
  "loan_applications", "login_events", "transactions", "accounts", "customers",
];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  dob TEXT,
  national_id TEXT,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT,
  city TEXT,
  onboarding_date TEXT NOT NULL,
  onboarding_channel TEXT,
  kyc_status TEXT,
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
  device_id TEXT NOT NULL,
  ip_address TEXT,
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
  status TEXT,${PROVENANCE}
);
CREATE INDEX IF NOT EXISTS idx_loan_customer ON loan_applications(customer_id);

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
`;
