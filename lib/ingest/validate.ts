import { z } from "zod";
import type { DatasetType } from "./fields";
import {
  normAddress, normEmail, normEnum, normName, normOutcome, normPhone, normProduct,
  parseAmount, parseTimestamp, surnameOf,
} from "@/lib/util/normalize";

export type Issue = { field: string | null; message: string };
export type RowResult = { record?: Record<string, string | number | null>; errors: Issue[]; warnings: Issue[] };

const TXN_STATUS: Record<string, string> = {
  completed: "completed", complete: "completed", success: "completed", successful: "completed", posted: "completed", settled: "completed", done: "completed",
  pending: "pending", processing: "pending", initiated: "pending", in_progress: "pending",
  failed: "failed", failure: "failed", declined: "failed", rejected: "failed", error: "failed",
  reversed: "reversed", reversal: "reversed", refunded: "reversed", returned: "reversed",
};
const TXN_TYPES = ["transfer", "payment", "disbursement", "deposit"] as const;
const EVENT_TYPES: Record<string, string> = {
  login: "login", sign_in: "login", signin: "login", logon: "login",
  password_reset: "password_reset", reset_password: "password_reset", pwd_reset: "password_reset", password_change: "password_reset", forgot_password: "password_reset",
  beneficiary_add: "beneficiary_add", add_beneficiary: "beneficiary_add", payee_add: "beneficiary_add", new_payee: "beneficiary_add", add_payee: "beneficiary_add", beneficiary_change: "beneficiary_add",
  device_change: "device_change", device_registration: "device_change", new_device: "device_change", device_bind: "device_change",
  profile_change: "profile_change", profile_update: "profile_change", change_mobile: "profile_change", change_email: "profile_change", mobile_change: "profile_change", email_change: "profile_change",
};

const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const key = (v: unknown) => text(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Normalises one mapped row. Missing or unreadable mandatory values become errors (row rejected);
 * unreadable optional values become warnings and are stored as null. Nothing is silently dropped.
 */
export function validateRow(type: DatasetType, row: Record<string, unknown>, defaults: Record<string, string> = {}): RowResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if ("__invalid__" in row) return { errors: [{ field: null, message: `Entry is not a record: ${String(row.__invalid__).slice(0, 80)}` }], warnings };

  const required = (field: string) => {
    const v = text(row[field]);
    if (v === "") errors.push({ field, message: `${field} is required` });
    return v;
  };
  const optional = (field: string) => text(row[field]) || null;
  const requiredTime = (field: string) => {
    const raw = row[field];
    if (text(raw) === "") {
      errors.push({ field, message: `${field} is required` });
      return null;
    }
    const t = parseTimestamp(raw);
    if (!t) errors.push({ field, message: `${field} "${text(raw)}" is not a valid date/time (use ISO 8601, YYYY-MM-DD HH:mm or DD/MM/YYYY HH:mm)` });
    return t;
  };
  const optionalTime = (field: string) => {
    if (text(row[field]) === "") return null;
    const t = parseTimestamp(row[field]);
    if (!t) warnings.push({ field, message: `${field} "${text(row[field])}" is not a valid date; stored as empty` });
    return t;
  };
  const positiveAmount = (field: string) => {
    if (text(row[field]) === "") {
      errors.push({ field, message: `${field} is required` });
      return null;
    }
    const a = parseAmount(row[field]);
    if (a === null) errors.push({ field, message: `${field} "${text(row[field])}" is not a number` });
    else if (a <= 0) errors.push({ field, message: `${field} must be greater than 0 (got ${a})` });
    return a;
  };
  const optionalAmount = (field: string) => {
    if (text(row[field]) === "") return null;
    const a = parseAmount(row[field]);
    if (a === null || a < 0) {
      warnings.push({ field, message: `${field} "${text(row[field])}" is not a valid amount; stored as empty` });
      return null;
    }
    return a;
  };
  const withDefault = (field: string) => {
    const v = text(row[field]);
    return v !== "" ? v : (defaults[field] ?? "");
  };

  let record: Record<string, string | number | null> = {};
  switch (type) {
    case "customers": {
      const full_name = required("full_name");
      const phone = required("phone");
      const email = required("email");
      if (phone && normPhone(phone).length < 10) errors.push({ field: "phone", message: `phone "${phone}" has fewer than 10 digits` });
      if (email && !emailSchema.safeParse(email).success) errors.push({ field: "email", message: `email "${email}" is not a valid address` });
      const address = optional("address");
      record = {
        customer_id: required("customer_id"),
        full_name,
        dob: optionalTime("dob")?.slice(0, 10) ?? null,
        national_id: optional("national_id")?.toUpperCase() ?? null,
        phone,
        email,
        address,
        city: optional("city"),
        onboarding_date: requiredTime("onboarding_date"),
        onboarding_channel: optional("onboarding_channel"),
        kyc_status: optional("kyc_status"),
        occupation: optional("occupation"),
        declared_income: optionalAmount("declared_income"),
        name_norm: normName(full_name),
        surname: surnameOf(full_name),
        phone_norm: normPhone(phone),
        email_norm: normEmail(email),
        address_norm: address ? normAddress(address) : null,
      };
      break;
    }
    case "accounts": {
      const rawProduct = required("product");
      const product = rawProduct ? normProduct(rawProduct) : null;
      if (rawProduct && !product) errors.push({ field: "product", message: `product "${rawProduct}" is not one of banking, lending, insurance, cards` });
      record = {
        account_id: required("account_id"),
        customer_id: required("customer_id"),
        product,
        account_type: optional("account_type"),
        opened_at: requiredTime("opened_at"),
        status: optional("status")?.toLowerCase() ?? null,
      };
      break;
    }
    case "transactions": {
      const statusRaw = withDefault("status");
      let status = TXN_STATUS[key(statusRaw)] ?? null;
      if (!status) {
        warnings.push({ field: "status", message: `status "${statusRaw}" is not recognised; stored as "${key(statusRaw) || "unknown"}"` });
        status = key(statusRaw) || "unknown";
      }
      const application_id = optional("application_id");
      let type = normEnum(row.type, TXN_TYPES);
      if (!type) {
        if (text(row.type) !== "") warnings.push({ field: "type", message: `type "${text(row.type)}" is not recognised; treated as transfer` });
        type = application_id ? "disbursement" : "transfer";
      }
      const account_id = required("account_id");
      const beneficiary_account = required("beneficiary_account");
      if (account_id && account_id === beneficiary_account) errors.push({ field: "beneficiary_account", message: "beneficiary_account is the same as account_id" });
      record = {
        transaction_id: required("transaction_id"),
        account_id,
        beneficiary_account,
        beneficiary_name: optional("beneficiary_name"),
        amount: positiveAmount("amount"),
        currency: (optional("currency") ?? "INR").toUpperCase(),
        timestamp: requiredTime("timestamp"),
        channel: key(withDefault("channel")) || "unknown",
        status,
        type,
        application_id,
      };
      break;
    }
    case "login_events": {
      const outcomeRaw = required("outcome");
      const outcome = outcomeRaw ? normOutcome(outcomeRaw) : null;
      if (outcomeRaw && !outcome) errors.push({ field: "outcome", message: `outcome "${outcomeRaw}" must mean success or failure` });
      const et = key(row.event_type);
      let event_type = EVENT_TYPES[et];
      if (!event_type) {
        if (et !== "") warnings.push({ field: "event_type", message: `event_type "${text(row.event_type)}" is not recognised; stored as "${et}"` });
        event_type = et || "login";
      }
      record = {
        event_id: required("event_id"),
        customer_id: required("customer_id"),
        device_id: required("device_id"),
        ip_address: optional("ip_address"),
        geo: optional("geo"),
        timestamp: requiredTime("timestamp"),
        outcome,
        event_type,
      };
      break;
    }
    case "loan_applications": {
      const phone = optional("phone");
      const email = optional("email");
      record = {
        application_id: required("application_id"),
        customer_id: required("customer_id"),
        device_id: optional("device_id"),
        phone,
        email,
        phone_norm: phone ? normPhone(phone) : null,
        email_norm: email ? normEmail(email) : null,
        requested_amount: positiveAmount("requested_amount"),
        payout_account: required("payout_account"),
        submitted_at: requiredTime("submitted_at"),
        status: optional("status")?.toLowerCase() ?? null,
        declared_income: optionalAmount("declared_income"),
        employer: optional("employer"),
        loan_purpose: optional("loan_purpose")?.toLowerCase() ?? null,
      };
      break;
    }
    case "insurance_claims": {
      const incident = requiredTime("incident_date");
      const submitted = requiredTime("submitted_at");
      if (incident && submitted && incident > submitted) errors.push({ field: "incident_date", message: "incident_date is after submitted_at" });
      const amount = positiveAmount("claim_amount");
      const sumInsured = optionalAmount("sum_insured");
      if (amount && sumInsured && amount > sumInsured) warnings.push({ field: "claim_amount", message: `claim_amount exceeds sum_insured (${sumInsured})` });
      record = {
        claim_id: required("claim_id"),
        policy_id: required("policy_id"),
        customer_id: required("customer_id"),
        claim_type: key(required("claim_type")),
        incident_date: incident,
        submitted_at: submitted,
        claim_amount: amount,
        sum_insured: sumInsured,
        policy_start_date: optionalTime("policy_start_date"),
        provider_id: optional("provider_id"),
        payout_account: required("payout_account"),
        device_id: optional("device_id"),
        document_hash: optional("document_hash"),
        status: optional("status")?.toLowerCase() ?? null,
        description: optional("description"),
      };
      break;
    }
  }
  return errors.length > 0 ? { errors, warnings } : { record, errors, warnings };
}
