import { normHeader } from "@/lib/util/normalize";

export const DATASET_TYPES = ["customers", "accounts", "transactions", "login_events", "loan_applications", "insurance_claims"] as const;
export type DatasetType = (typeof DATASET_TYPES)[number];

export const DATASET_LABELS: Record<DatasetType, string> = {
  customers: "Customers",
  accounts: "Accounts",
  transactions: "Transactions",
  login_events: "Device & login events",
  loan_applications: "Loan applications",
  insurance_claims: "Insurance claims",
};

/** Insert order that lets later types resolve references to earlier ones. */
export const LOAD_ORDER: DatasetType[] = ["customers", "accounts", "loan_applications", "insurance_claims", "login_events", "transactions"];

export const PRIMARY_KEY: Record<DatasetType, string> = {
  customers: "customer_id",
  accounts: "account_id",
  transactions: "transaction_id",
  login_events: "event_id",
  loan_applications: "application_id",
  insurance_claims: "claim_id",
};

/** Required columns: a row missing any of these is rejected. */
export const MANDATORY: Record<DatasetType, string[]> = {
  customers: ["customer_id", "full_name", "phone", "email", "onboarding_date"],
  accounts: ["account_id", "customer_id", "product", "opened_at"],
  transactions: ["transaction_id", "account_id", "beneficiary_account", "amount", "timestamp"],
  login_events: ["event_id", "customer_id", "device_id", "timestamp", "outcome"],
  loan_applications: ["application_id", "customer_id", "requested_amount", "payout_account", "submitted_at"],
  insurance_claims: ["claim_id", "policy_id", "customer_id", "claim_type", "incident_date", "submitted_at", "claim_amount", "payout_account"],
};

/** Expected columns that get a visible default (file-level notice) when the whole column is absent. */
export const DEFAULTED: Partial<Record<DatasetType, Record<string, string>>> = {
  transactions: { channel: "unknown", status: "completed" },
};

const COMMON_ALIASES: Record<string, string[]> = {
  customer_id: ["customer_id", "cust_id", "customerid", "customer_no", "customer_number", "client_id", "cif", "cif_id", "customer"],
  account_id: ["account_id", "acct_id", "account_no", "account_number", "accountid", "account"],
  device_id: ["device_id", "device", "deviceid", "device_fingerprint", "fingerprint"],
  phone: ["phone", "mobile", "phone_number", "mobile_number", "contact", "contact_number", "msisdn"],
  email: ["email", "email_id", "email_address", "mail"],
  application_id: ["application_id", "app_id", "loan_application_id", "application_no", "applicationid"],
};

const ALIASES: Record<DatasetType, Record<string, string[]>> = {
  customers: {
    customer_id: COMMON_ALIASES.customer_id,
    full_name: ["full_name", "name", "customer_name", "fullname", "client_name"],
    dob: ["dob", "date_of_birth", "birth_date", "birthdate"],
    national_id: ["national_id", "pan", "pan_number", "aadhaar", "id_number", "national_id_number", "tax_id"],
    phone: COMMON_ALIASES.phone,
    email: COMMON_ALIASES.email,
    address: ["address", "residential_address", "address_line", "street_address"],
    city: ["city", "town"],
    onboarding_date: ["onboarding_date", "onboarded_at", "onboarded_on", "registration_date", "created_at", "customer_since", "join_date"],
    onboarding_channel: ["onboarding_channel", "acquisition_channel", "signup_channel"],
    kyc_status: ["kyc_status", "kyc"],
    occupation: ["occupation", "profession", "employment_type", "job"],
    declared_income: ["declared_income", "annual_income", "income", "yearly_income", "gross_income"],
  },
  accounts: {
    account_id: COMMON_ALIASES.account_id,
    customer_id: COMMON_ALIASES.customer_id,
    product: ["product", "product_type", "line_of_business", "system", "business_line"],
    account_type: ["account_type", "type", "acct_type", "sub_product"],
    opened_at: ["opened_at", "open_date", "opened_on", "account_open_date", "created_at", "opening_date"],
    status: ["status", "account_status"],
  },
  transactions: {
    transaction_id: ["transaction_id", "txn_id", "transactionid", "txn_ref", "reference", "reference_id", "trans_id", "utr"],
    account_id: ["account_id", "from_account", "sender_account", "debit_account", "source_account", "payer_account", "account_no", "sender"],
    beneficiary_account: ["beneficiary_account", "to_account", "beneficiary", "payee_account", "credit_account", "destination_account", "receiver_account", "beneficiary_account_no"],
    beneficiary_name: ["beneficiary_name", "payee_name", "receiver_name", "to_name"],
    amount: ["amount", "txn_amount", "transaction_amount", "value", "amt"],
    currency: ["currency", "ccy"],
    timestamp: ["timestamp", "txn_time", "transaction_time", "date_time", "datetime", "txn_date", "transaction_date", "date", "time", "created_at"],
    channel: ["channel", "txn_channel", "mode", "payment_mode", "transaction_channel"],
    status: ["status", "txn_status", "transaction_status", "state"],
    type: ["type", "txn_type", "transaction_type"],
    application_id: COMMON_ALIASES.application_id,
  },
  login_events: {
    event_id: ["event_id", "login_id", "session_id", "log_id", "eventid", "id"],
    customer_id: COMMON_ALIASES.customer_id.concat(["user_id", "userid"]),
    device_id: COMMON_ALIASES.device_id,
    ip_address: ["ip_address", "ip", "ipaddress", "source_ip", "client_ip"],
    geo: ["geo", "location", "geo_location", "city", "country", "region"],
    timestamp: ["timestamp", "login_time", "event_time", "login_timestamp", "datetime", "date_time", "time", "date"],
    outcome: ["outcome", "auth_result", "result", "login_status", "authentication_outcome", "auth_status", "status", "success"],
    event_type: ["event_type", "action", "activity", "event", "type"],
  },
  loan_applications: {
    application_id: COMMON_ALIASES.application_id,
    customer_id: COMMON_ALIASES.customer_id.concat(["applicant_id"]),
    device_id: COMMON_ALIASES.device_id,
    phone: COMMON_ALIASES.phone,
    email: COMMON_ALIASES.email,
    requested_amount: ["requested_amount", "loan_amount", "amount", "requested_loan_amount", "principal"],
    payout_account: ["payout_account", "disbursement_account", "credit_account", "bank_account", "payout_account_no"],
    submitted_at: ["submitted_at", "application_date", "applied_at", "submission_time", "created_at", "timestamp", "date"],
    status: ["status", "application_status", "decision"],
    declared_income: ["declared_income", "annual_income", "income", "stated_income", "applicant_income"],
    employer: ["employer", "employer_name", "company", "organisation", "organization"],
    loan_purpose: ["loan_purpose", "purpose", "end_use"],
  },
  insurance_claims: {
    claim_id: ["claim_id", "claim_no", "claim_number", "claimid", "claim_ref"],
    policy_id: ["policy_id", "policy_no", "policy_number", "policyid", "account_id"],
    customer_id: COMMON_ALIASES.customer_id.concat(["claimant_id", "insured_id", "policyholder_id"]),
    claim_type: ["claim_type", "line_of_business", "cover_type", "type", "product"],
    incident_date: ["incident_date", "loss_date", "date_of_loss", "event_date", "accident_date", "admission_date"],
    submitted_at: ["submitted_at", "claim_date", "reported_at", "notification_date", "filed_at", "intimation_date"],
    claim_amount: ["claim_amount", "amount_claimed", "claimed_amount", "amount", "claim_value"],
    sum_insured: ["sum_insured", "sum_assured", "cover_amount", "coverage", "insured_amount"],
    policy_start_date: ["policy_start_date", "inception_date", "policy_start", "risk_start_date", "cover_start"],
    provider_id: ["provider_id", "provider", "hospital", "hospital_id", "garage", "garage_id", "workshop", "network_provider"],
    payout_account: ["payout_account", "settlement_account", "bank_account", "beneficiary_account", "payee_account"],
    device_id: COMMON_ALIASES.device_id,
    document_hash: ["document_hash", "doc_hash", "invoice_hash", "bill_hash", "document_fingerprint", "invoice_number", "bill_number"],
    status: ["status", "claim_status", "decision"],
    description: ["description", "remarks", "narrative", "loss_description", "notes"],
  },
};

const TYPE_HINTS: Record<string, DatasetType> = {
  customers: "customers", customer: "customers", customer_profiles: "customers", profiles: "customers", kyc: "customers",
  accounts: "accounts", account: "accounts", account_profiles: "accounts",
  transactions: "transactions", transaction: "transactions", txns: "transactions", txn: "transactions", payments: "transactions", transfers: "transactions",
  login_events: "login_events", logins: "login_events", login: "login_events", devices: "login_events", device_logs: "login_events", device_login_logs: "login_events", auth_logs: "login_events", sessions: "login_events",
  loan_applications: "loan_applications", loans: "loan_applications", loan: "loan_applications", applications: "loan_applications", lending: "loan_applications",
  insurance_claims: "insurance_claims", claims: "insurance_claims", claim: "insurance_claims", insurance: "insurance_claims",
};

export function typeFromHint(hint: string | undefined): DatasetType | undefined {
  if (!hint) return undefined;
  const h = normHeader(hint.replace(/\.(csv|xlsx|xls|json)$/i, "")).replace(/^\d+_|_\d+$/g, "");
  if (TYPE_HINTS[h]) return TYPE_HINTS[h];
  for (const [key, type] of Object.entries(TYPE_HINTS)) if (h.includes(key)) return type;
  return undefined;
}

export type HeaderMapping = {
  type: DatasetType;
  /** source header → canonical field */
  map: Record<string, string>;
  unmapped: string[];
  missingMandatory: string[];
  coverage: number;
};

/** Maps raw headers onto one dataset type's fields. Exact field names win over aliases. */
export function mapHeaders(headers: string[], type: DatasetType): HeaderMapping {
  const aliases = ALIASES[type];
  const map: Record<string, string> = {};
  const taken = new Set<string>();
  const normalized = headers.map((h) => [h, normHeader(h)] as const);
  for (const pass of ["exact", "alias"] as const) {
    for (const [raw, norm] of normalized) {
      if (map[raw]) continue;
      for (const [field, list] of Object.entries(aliases)) {
        if (taken.has(field)) continue;
        const hit = pass === "exact" ? norm === field : list.includes(norm);
        if (hit) {
          map[raw] = field;
          taken.add(field);
          break;
        }
      }
    }
  }
  const missingMandatory = MANDATORY[type].filter((f) => !taken.has(f));
  return {
    type,
    map,
    unmapped: headers.filter((h) => !map[h]),
    missingMandatory,
    coverage: (MANDATORY[type].length - missingMandatory.length) / MANDATORY[type].length,
  };
}

export const MIN_COVERAGE = 0.6;

/**
 * Picks the dataset type whose mandatory fields the headers cover best.
 * An explicit override or a matching sheet/file name is used when it reaches the minimum coverage.
 */
export function detectType(headers: string[], hint?: string, override?: DatasetType): HeaderMapping | { error: string; candidates: HeaderMapping[] } {
  const candidates = DATASET_TYPES.map((t) => mapHeaders(headers, t));
  const byType = (t: DatasetType) => candidates.find((c) => c.type === t)!;
  if (override) {
    const m = byType(override);
    return m.coverage >= MIN_COVERAGE ? m : { error: `Columns do not match ${DATASET_LABELS[override]}: missing ${m.missingMandatory.join(", ")}`, candidates };
  }
  const hinted = typeFromHint(hint);
  if (hinted && byType(hinted).coverage >= MIN_COVERAGE) return byType(hinted);
  const ranked = [...candidates].sort((a, b) => b.coverage - a.coverage || Object.keys(b.map).length - Object.keys(a.map).length);
  const best = ranked[0];
  if (best.coverage < MIN_COVERAGE || !best.map || !Object.values(best.map).includes(PRIMARY_KEY[best.type])) {
    return { error: `Unrecognised file: closest match is ${DATASET_LABELS[best.type]}, missing ${best.missingMandatory.join(", ") || PRIMARY_KEY[best.type]}`, candidates };
  }
  return best;
}
