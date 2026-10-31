import { z } from "zod";
import { policy } from "@/lib/policy";
import { hashObject } from "@/lib/util/hash";
import type { DatasetType } from "./fields";
import {
  isPlaceholder, normAddress, normEmail, normEnum, normName, normOutcome, normPhone, normProduct,
  parseAmount, parseTimestamp, surnameOf, type DateOrder,
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
export type RowOptions = {
  /** Day/month order per date column, decided from the whole column by the loader. */
  dateOrders?: Record<string, DateOrder>;
  /** Offset applied to times without one (policy.ingest.defaultTimezone). */
  defaultOffset?: string;
};

export function validateRow(type: DatasetType, row: Record<string, unknown>, defaults: Record<string, string> = {}, opts: RowOptions = {}): RowResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if ("__invalid__" in row) return { errors: [{ field: null, message: `Entry is not a record: ${String(row.__invalid__).slice(0, 80)}` }], warnings };

  const required = (field: string) => {
    const v = text(row[field]);
    if (v === "") errors.push({ field, message: `${field} is required` });
    return v;
  };
  const optional = (field: string) => text(row[field]) || null;
  /** An identifier that links customers; placeholders ("unknown", "NA", "0000") are stored as empty so they never do. */
  const identifier = (field: string) => {
    const v = text(row[field]);
    if (v === "") return null;
    if (isPlaceholder(v)) {
      warnings.push({ field, message: `${field} "${v}" looks like a placeholder; stored as empty so it cannot link customers` });
      return null;
    }
    return v;
  };
  const requiredIdentifier = (field: string) => {
    const v = required(field);
    if (v && isPlaceholder(v, 1)) errors.push({ field, message: `${field} "${v}" is a placeholder, not a real identifier` });
    return v;
  };
  const time = (field: string) => parseTimestamp(row[field], { order: opts.dateOrders?.[field], defaultOffset: opts.defaultOffset });
  const requiredTime = (field: string) => {
    const raw = row[field];
    if (text(raw) === "") {
      errors.push({ field, message: `${field} is required` });
      return null;
    }
    const t = time(field);
    if (!t) errors.push({ field, message: `${field} "${text(raw)}" is not a valid date/time (e.g. ISO 8601, YYYY-MM-DD HH:mm, DD/MM/YYYY hh:mm AM, 05-Oct-2026, epoch seconds)` });
    return t;
  };
  const optionalTime = (field: string) => {
    if (text(row[field]) === "") return null;
    const t = time(field);
    if (!t) warnings.push({ field, message: `${field} "${text(row[field])}" is not a valid date; stored as empty` });
    return t;
  };
  const positiveAmount = (field: string) => {
    if (text(row[field]) === "") {
      errors.push({ field, message: `${field} is required` });
      return null;
    }
    const a = parseAmount(row[field]);
    if (a === null) {
      errors.push({ field, message: `${field} "${text(row[field])}" is not a number` });
      return null;
    }
    if (a === 0) {
      errors.push({ field, message: `${field} must not be zero` });
      return null;
    }
    if (a < 0) {
      // Signed exports (−5,000 = debit) are common; keep the magnitude and say so.
      warnings.push({ field, message: `${field} ${a} is negative (signed debit); stored as ${Math.abs(a)}` });
      return Math.abs(a);
    }
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
  // Optional session telemetry: a bad value is dropped with a warning, never rejects the login event.
  const telemetryInt = (field: string) => {
    const v = text(row[field]);
    if (v === "") return null;
    const n = Number(v.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) { warnings.push({ field, message: `${field} "${v}" is not a non-negative number; stored as empty` }); return null; }
    return Math.round(n);
  };
  const telemetryFlag = (field: string) => {
    const v = text(row[field]).toLowerCase();
    if (v === "") return null;
    if (["1", "true", "yes", "y", "detected"].includes(v)) return 1;
    if (["0", "false", "no", "n", "none"].includes(v)) return 0;
    warnings.push({ field, message: `${field} "${v}" is not yes/no; stored as empty` });
    return null;
  };
  const telemetryScore = (field: string) => {
    const v = text(row[field]);
    if (v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) { warnings.push({ field, message: `${field} "${v}" must be between 0 and 1; stored as empty` }); return null; }
    return n;
  };
  // Verify-payee / confirmation-of-payee result: whether the beneficiary name matched the account holder.
  const payeeCheck = () => {
    const v = key(row.payee_name_check);
    if (v === "") return null;
    const m: Record<string, string> = { match: "match", matched: "match", full_match: "match", yes: "match", partial: "partial", close_match: "partial", partial_match: "partial", no_match: "no_match", mismatch: "no_match", no: "no_match", not_checked: "not_checked", unavailable: "not_checked", na: "not_checked" };
    if (m[v]) return m[v];
    warnings.push({ field: "payee_name_check", message: `payee_name_check "${text(row.payee_name_check)}" is not match / partial / no_match / not_checked; stored as empty` });
    return null;
  };
  const withDefault = (field: string) => {
    const v = text(row[field]);
    return v !== "" ? v : (defaults[field] ?? "");
  };

  let record: Record<string, string | number | null> = {};
  switch (type) {
    case "customers": {
      const full_name = required("full_name");
      let phone = identifier("phone");
      let email = identifier("email");
      if (phone && normPhone(phone).length < 7) {
        warnings.push({ field: "phone", message: `phone "${phone}" has too few digits; stored as empty` });
        phone = null;
      }
      if (email && !emailSchema.safeParse(email).success) {
        warnings.push({ field: "email", message: `email "${email}" is not a valid address; stored as empty` });
        email = null;
      }
      const address = optional("address");
      record = {
        customer_id: required("customer_id"),
        full_name,
        dob: optionalTime("dob")?.slice(0, 10) ?? null,
        national_id: identifier("national_id")?.toUpperCase() ?? null,
        phone,
        email,
        address,
        city: optional("city"),
        onboarding_date: optionalTime("onboarding_date"),
        onboarding_channel: optional("onboarding_channel"),
        kyc_status: optional("kyc_status"),
        occupation: optional("occupation"),
        declared_income: optionalAmount("declared_income"),
        name_norm: normName(full_name),
        surname: surnameOf(full_name),
        phone_norm: phone ? normPhone(phone) : null,
        email_norm: email ? normEmail(email) : null,
        address_norm: address ? normAddress(address) : null,
      };
      break;
    }
    case "accounts": {
      const rawProduct = required("product");
      let product = rawProduct ? normProduct(rawProduct) : null;
      if (rawProduct && !product) {
        warnings.push({ field: "product", message: `product "${rawProduct}" is not recognised; treated as banking` });
        product = "banking";
      }
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
      const amount = positiveAmount("amount");
      const currency = (optional("currency") ?? "INR").toUpperCase().replace(/[^A-Z]/g, "") || "INR";
      const rates = policy.ingest.fxToInr as Record<string, number>;
      let rate = rates[currency];
      if (rate === undefined) {
        warnings.push({ field: "currency", message: `no INR rate for currency "${currency}"; amounts compared 1:1 with INR` });
        rate = 1;
      }
      const account_id = requiredIdentifier("account_id");
      const beneficiary_account = requiredIdentifier("beneficiary_account");
      if (account_id && account_id === beneficiary_account) errors.push({ field: "beneficiary_account", message: "beneficiary_account is the same as account_id" });
      record = {
        transaction_id: required("transaction_id"),
        account_id,
        beneficiary_account,
        beneficiary_name: optional("beneficiary_name"),
        amount,
        currency,
        amount_inr: amount === null ? null : Math.round(amount * rate * 100) / 100,
        timestamp: requiredTime("timestamp"),
        channel: key(withDefault("channel")) || "unknown",
        status,
        type,
        application_id,
        payee_name_check: payeeCheck(),
      };
      break;
    }
    case "login_events": {
      const outcomeRaw = required("outcome");
      const outcome = outcomeRaw ? normOutcome(outcomeRaw) : null;
      if (outcomeRaw && !outcome) errors.push({ field: "outcome", message: `outcome "${outcomeRaw}" must mean success or failure` });
      const ua = optional("user_agent");
      let device_id = identifier("device_id");
      if (!device_id && ua) {
        device_id = `ua:${hashObject(ua).slice(0, 12)}`;
        warnings.push({ field: "device_id", message: `no device ID; derived ${device_id} from the user agent` });
      } else if (!device_id && text(row.device_id) === "") {
        warnings.push({ field: "device_id", message: "no device ID; device-based checks skip this event" });
      }
      const et = key(row.event_type);
      let event_type = EVENT_TYPES[et];
      if (!event_type) {
        if (et !== "") warnings.push({ field: "event_type", message: `event_type "${text(row.event_type)}" is not recognised; stored as "${et}"` });
        event_type = et || "login";
      }
      record = {
        event_id: required("event_id"),
        customer_id: required("customer_id"),
        device_id,
        ip_address: identifier("ip_address"),
        user_agent: ua,
        sim_swap_days: telemetryInt("sim_swap_days"),
        remote_access: telemetryFlag("remote_access"),
        emulator_or_rooted: telemetryFlag("emulator_or_rooted"),
        vpn_proxy: telemetryFlag("vpn_proxy"),
        session_seconds: telemetryInt("session_seconds"),
        typing_anomaly: telemetryScore("typing_anomaly"),
        geo: optional("geo"),
        timestamp: requiredTime("timestamp"),
        outcome,
        event_type,
      };
      break;
    }
    case "loan_applications": {
      const phone = identifier("phone");
      const email = identifier("email");
      record = {
        application_id: required("application_id"),
        customer_id: required("customer_id"),
        device_id: identifier("device_id"),
        phone,
        email,
        phone_norm: phone ? normPhone(phone) : null,
        email_norm: email ? normEmail(email) : null,
        requested_amount: positiveAmount("requested_amount"),
        payout_account: requiredIdentifier("payout_account"),
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
        provider_id: identifier("provider_id"),
        payout_account: requiredIdentifier("payout_account"),
        device_id: identifier("device_id"),
        document_hash: identifier("document_hash"),
        status: optional("status")?.toLowerCase() ?? null,
        description: optional("description"),
      };
      break;
    }
  }
  return errors.length > 0 ? { errors, warnings } : { record, errors, warnings };
}
