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
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const TIME = String.raw`(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp]\.?[Mm]\.?)?)?`;
const OFFSET = String.raw`\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?`;
const RE_YMD = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}${OFFSET}$`);
const RE_XY = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})${TIME}${OFFSET}$`);
const RE_DMONY = new RegExp(String.raw`^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4})${TIME}${OFFSET}$`);
const RE_MONDY = new RegExp(String.raw`^([A-Za-z]{3,9})[- ]+(\d{1,2}),?[- ]+(\d{4})${TIME}${OFFSET}$`);

export type DateOrder = "DMY" | "MDY";
export type TimeOptions = {
  /** Order for ambiguous slash/dash dates such as 03/04/2026. */
  order?: DateOrder;
  /** Offset applied to values that have a time but no offset, e.g. "+05:30". Date-only values stay calendar dates (UTC midnight). */
  defaultOffset?: string;
};

/**
 * Accepts ISO 8601 (with or without a space before the offset), YYYY/MM/DD, DD/MM/YYYY or MM/DD/YYYY
 * (order chosen per column), DD-Mon-YYYY, Mon DD YYYY, 12-hour times with AM/PM, Unix epoch seconds or
 * milliseconds, Excel serial dates and Date objects. Returns an ISO string, or null when unreadable.
 */
export function parseTimestamp(value: unknown, opts: TimeOptions = {}): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    if (value >= 1e12) return new Date(value).toISOString();
    if (value >= 1e9) return new Date(value * 1000).toISOString();
    if (value > 20000 && value < 80000) return new Date(EXCEL_EPOCH_MS + value * 86400000).toISOString();
    return null;
  }
  const s = String(value).trim();
  if (/^\d{13}$/.test(s) || /^\d{10}$/.test(s)) return parseTimestamp(Number(s), opts);
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseTimestamp(Number(s), opts);

  let y: number, mo: number, d: number, rest: string[];
  let m = s.match(RE_YMD);
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    rest = m.slice(4);
  } else if ((m = s.match(RE_XY))) {
    const [a, b] = [+m[1], +m[2]];
    const mdy = opts.order === "MDY" ? !(a > 12) : b > 12;
    [d, mo] = mdy ? [b, a] : [a, b];
    y = +m[3];
    rest = m.slice(4);
  } else if ((m = s.match(RE_DMONY))) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (!month) return null;
    [d, mo, y] = [+m[1], month, +m[3]];
    rest = m.slice(4);
  } else if ((m = s.match(RE_MONDY))) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (!month) return null;
    [mo, d, y] = [month, +m[2], +m[3]];
    rest = m.slice(4);
  } else {
    return null;
  }
  const [hRaw, mi, sec, ampm, tzRaw] = rest;
  let h = hRaw === undefined ? 0 : +hRaw;
  if (ampm) {
    const pm = ampm.toLowerCase().startsWith("p");
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || (mi !== undefined && +mi > 59) || (sec !== undefined && +sec > 59)) return null;
  let tz = tzRaw ? (/^(z|utc|gmt)$/i.test(tzRaw) ? "Z" : tzRaw.length === 5 ? `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}` : tzRaw) : "";
  if (!tz) tz = hRaw !== undefined && opts.defaultOffset ? opts.defaultOffset : "Z";
  const pad = (n: number | string) => String(n).padStart(2, "0");
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi ?? 0)}:${pad(sec ?? 0)}${tz}`;
  return validIso(iso, y, mo, d);
}

/**
 * Decides day/month order for one column of slash or dash dates: a first part above 12 means DD/MM,
 * a second part above 12 means MM/DD. When nothing decides it, DD/MM is used and reported as ambiguous.
 */
export function detectDateOrder(values: unknown[]): { order: DateOrder; ambiguous: boolean; conflicting: boolean } {
  let dmy = false;
  let mdy = false;
  let seen = false;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = v.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}/);
    if (!m) continue;
    seen = true;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (mdy && !dmy) return { order: "MDY", ambiguous: false, conflicting: false };
  return { order: "DMY", ambiguous: seen && !dmy && !mdy, conflicting: dmy && mdy };
}

/** Rejects impossible calendar dates (31/02) that Date would silently roll over. */
function validIso(iso: string, year: number, month: number, day: number): string | null {
  const t = new Date(iso);
  const cal = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(t.getTime()) || cal.getUTCMonth() !== month - 1 || cal.getUTCDate() !== day) return null;
  return t.toISOString();
}

/**
 * "₹1,20,000.50" → 120000.5. Also reads "$500", "USD 500", "500 Dr" (negative), "500 Cr", "(500)" (negative).
 * Returns null for anything that is not a finite number.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bdr\.?$/i.test(s)) {
    sign = -sign;
    s = s.replace(/\bdr\.?$/i, "");
  }
  s = s.replace(/\bcr\.?$/i, "").replace(/[₹$€£,\s]|INR|USD|EUR|GBP|AED|SGD|Rs\.?/gi, "");
  if (s === "" || !/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return sign * Number(s);
}

const OUTCOMES: Record<string, "success" | "failure"> = {
  success: "success", succeeded: "success", successful: "success", ok: "success", true: "success", "1": "success", pass: "success", passed: "success", y: "success", yes: "success", s: "success",
  failure: "failure", fail: "failure", failed: "failure", false: "failure", "0": "failure", denied: "failure", error: "failure", rejected: "failure", n: "failure", no: "failure", f: "failure",
};
/** Exact vocabulary first, then substrings; failure terms are checked before success ("unsuccessful"). */
export function normOutcome(value: unknown): "success" | "failure" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (OUTCOMES[v]) return OUTCOMES[v];
  if (/fail|deny|denied|invalid|wrong|locked|block|reject|error|incorrect|unsuccess|expired|mismatch/.test(v)) return "failure";
  if (/succ|ok\b|pass|grant|allow|authenticated|verified/.test(v)) return "success";
  return null;
}

const PRODUCTS: Record<string, string> = {
  banking: "banking", bank: "banking", casa: "banking", savings: "banking", current: "banking", core_banking: "banking", deposit: "banking",
  lending: "lending", loan: "lending", loans: "lending", credit: "lending",
  insurance: "insurance", policy: "insurance",
  cards: "cards", card: "cards", credit_card: "cards", debit_card: "cards",
};
/** Exact names first, then common product words ("personal_loan", "savings_account", "wallet"). */
export function normProduct(value: unknown): string | null {
  const v = normHeader(String(value ?? ""));
  if (PRODUCTS[v]) return PRODUCTS[v];
  if (/card/.test(v)) return "cards";
  if (/loan|credit_line|mortgage|lend|emi|overdraft|bnpl/.test(v)) return "lending";
  if (/insur|policy|assurance|cover/.test(v)) return "insurance";
  if (/sav|current|casa|deposit|^fd|wallet|upi|account|bank/.test(v)) return "banking";
  return null;
}

const PLACEHOLDERS = new Set([
  "na", "n/a", "n.a", "n.a.", "nan", "null", "none", "nil", "unknown", "unk", "-", "--", "---", "0", "test", "dummy", "undefined",
  "not available", "not applicable", "notavailable", "default", "?", "tbd", "test@test.com", "test@example.com", "noemail@noemail.com", "no", "xx",
]);
/** Values that look like an identifier but mean "missing"; they must never link two customers. */
export function isPlaceholder(value: unknown, minLength = 3): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.length < minLength) return true;
  if (PLACEHOLDERS.has(v)) return true;
  if (/^(.)\1+$/.test(v.replace(/[^a-z0-9]/g, ""))) return true;
  if (/^(unknown|test|dummy|none|null)[-_ ]?\w{0,3}$/.test(v)) return true;
  return false;
}

export function normEnum(value: unknown, allowed: readonly string[], fallback?: string): string | null {
  const v = normHeader(String(value ?? ""));
  if (v === "") return fallback ?? null;
  return allowed.includes(v) ? v : null;
}
