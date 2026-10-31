const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  st: "street", rd: "road", ave: "avenue", apt: "apartment", flr: "floor",
  nr: "near", opp: "opposite", blk: "block", no: "", "#": "",
};

export function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function surnameOf(name: string): string {
  const parts = normName(name).split(" ");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Last 10 digits — Indian mobile numbers with or without +91 / 0 prefixes compare equal. */
export function normPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Lowercase; for Gmail also drop dots and +tags so aliases of one inbox compare equal. */
export function normEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1).replace("googlemail.com", "gmail.com");
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function normAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9#\s]/g, " ")
    .split(/\s+/)
    .map((w) => (w in ADDRESS_ABBREVIATIONS ? ADDRESS_ABBREVIATIONS[w] : w))
    .filter(Boolean)
    .join(" ");
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * Accepts ISO 8601, "YYYY-MM-DD HH:mm[:ss]", "DD/MM/YYYY[ HH:mm[:ss]]", Excel serial
 * numbers and Date objects. Timestamps without an offset are treated as UTC.
 * Returns an ISO string, or null when the value cannot be read unambiguously.
 */
export function parseTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    if (value > 20000 && value < 80000) return new Date(EXCEL_EPOCH_MS + value * 86400000).toISOString();
    return null;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", sec = "00", tz] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${tz ? (tz === "Z" ? "Z" : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz) : "Z"}`;
    return validIso(iso, +y, +mo, +d);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h = "0", mi = "00", sec = "00"] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${sec}Z`;
    return validIso(iso, +y, +mo, +d);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseTimestamp(Number(s));
  return null;
}

/** Rejects impossible calendar dates (31/02) that Date would silently roll over. */
function validIso(iso: string, year: number, month: number, day: number): string | null {
  const t = new Date(iso);
  const cal = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(t.getTime()) || cal.getUTCMonth() !== month - 1 || cal.getUTCDate() !== day) return null;
  return t.toISOString();
}

/** "₹1,20,000.50" → 120000.5. Returns null for anything that is not a finite number. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[₹,\s]|INR|Rs\.?/gi, "");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const OUTCOMES: Record<string, "success" | "failure"> = {
  success: "success", succeeded: "success", successful: "success", ok: "success", true: "success", "1": "success", pass: "success", passed: "success",
  failure: "failure", fail: "failure", failed: "failure", false: "failure", "0": "failure", denied: "failure", error: "failure", rejected: "failure",
};
export function normOutcome(value: unknown): "success" | "failure" | null {
  return OUTCOMES[String(value ?? "").trim().toLowerCase()] ?? null;
}

const PRODUCTS: Record<string, string> = {
  banking: "banking", bank: "banking", casa: "banking", savings: "banking", current: "banking", core_banking: "banking", deposit: "banking",
  lending: "lending", loan: "lending", loans: "lending", credit: "lending",
  insurance: "insurance", policy: "insurance",
  cards: "cards", card: "cards", credit_card: "cards", debit_card: "cards",
};
export function normProduct(value: unknown): string | null {
  return PRODUCTS[normHeader(String(value ?? ""))] ?? null;
}

export function normEnum(value: unknown, allowed: readonly string[], fallback?: string): string | null {
  const v = normHeader(String(value ?? ""));
  if (v === "") return fallback ?? null;
  return allowed.includes(v) ? v : null;
}
