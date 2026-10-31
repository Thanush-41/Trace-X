# TRACE X — Review log

Reviewer findings for the builder. P0 = breaks a judge run on unseen data · P1 = wrong or misleading result · P2 = improvement.
Each item: **where → what breaks → fix**. Mark items `[x]` when fixed so the reviewer can re-verify.

---

## Review 1 — commit `9159455` (ingestion path, judge-data focus)

Judges will upload data we've never seen. The biggest risk is that **valid real-world rows are rejected** or **placeholder values create fake fraud rings**. Fix these in order and stop when time runs out.

### P0 — fix before the Level 1 demo

- [ ] **R1-01 Placeholder values link unrelated customers into fake rings.**
  `fd02-device.ts`, `fd05-loan-ring.ts`, `fd04-identity.ts`: `device_id` / `phone` / `email` / `national_id` / `payout_account` values like `unknown`, `NA`, `N/A`, `null`, `none`, `-`, `0`, `0000000000`, `test@test.com` are treated as real shared identifiers. With 3–20 customers on a placeholder (under `hubDegree`), FD-02/FD-05 produce High alerts and FD-06 merges them into a "cross-system ring". A judge file with blank-ish device IDs fills the dashboard with false Highs.
  **Fix:** add one `isPlaceholder(v)` in `normalize.ts` (empty after trim, a known token list, all one repeated character such as `0000…`/`xxxx`, or length < 3). Store such values as `null` at ingest, with a warning. Do it once in `validate.ts` and every detector benefits.

- [ ] **R1-02 Customer rows are rejected when phone or email is missing.**
  `validate.ts:89-93`: `phone`, `email` and `onboarding_date` are required, and a phone with fewer than 10 digits is an error. Many customer extracts lack email or have landline/international numbers, so the **whole customer file is rejected**, every other file becomes an orphan, and detection finds almost nothing.
  **Fix:** mandatory = `customer_id` and `full_name` only. Phone, email and onboarding date become optional and get a *warning* when invalid. Check that the detectors null-guard `onboarding_date` (NEW_PROFILES, CLUSTERED_FIRST_USE).

- [ ] **R1-03 Unknown `product` rejects the account row.**
  `validate.ts:120`, `normalize.ts:103`: `personal_loan`, `home_loan`, `savings_account`, `current_account`, `fd`, `wallet`, `upi`, `mortgage`, `credit card` → rejected. Those accounts' transactions then lose their owner, which kills FD-01 baselines.
  **Fix:** match by substring (`loan|credit_line|mortgage` → lending, `card` → cards, `insur|policy` → insurance, `sav|current|casa|deposit|fd|wallet|upi|account` → banking). Unmatched → `banking` with a warning, not a rejection.

- [ ] **R1-04 Common timestamp formats are rejected, which rejects the row.**
  `normalize.ts:54` `parseTimestamp` rejects:
  - US `MM/DD/YYYY` (any day > 12 fails; worse, `03/04/2026` is silently read as 3 April)
  - `YYYY/MM/DD`, `DD-MM-YYYY`, `DD-Mon-YYYY` (`05-Oct-2026`)
  - 12-hour time with `AM/PM`
  - Unix epoch seconds or milliseconds (`1760000000`, `1760000000000`)
  - ISO with a space before the offset

  A whole transactions file in one of these formats → 100% rejected.
  **Fix:** add these patterns. For slash dates, decide the order **per column**: if any value's first part is > 12 → DD/MM; if any second part is > 12 → MM/DD; else default to DD/MM and add a file notice "ambiguous dates read as DD/MM". Numbers ≥ 1e9 are epoch seconds and ≥ 1e12 are epoch ms.

- [ ] **R1-05 Login outcome vocabulary is too narrow, so the row is rejected.**
  `normalize.ts:95`: `Y`/`N`, `S`/`F`, `LOGIN_SUCCESS`, `AUTH_FAILED`, `invalid_password`, `wrong_otp`, `locked`, `blocked`, `2FA_failed` → rejected. FD-03 then sees no failures, and ATO detection silently disappears.
  **Fix:** keep the exact map, then fall back to substring matching: `fail|deny|denied|invalid|wrong|locked|block|reject|error|incorrect` → failure; `succ|ok|pass|grant|allow` → success. Check the failure terms first.

### P1 — wrong or misleading results

- [ ] **R1-06 Mixed currencies are compared as if they were INR.** `validate.ts:153` stores the currency but FD-01 ignores it. A USD 3,000 transfer is ₹3,000 for HIGH_VALUE, and mixed-currency accounts get garbage baselines. **Fix (cheap):** put an `fx_to_inr` map in `policy.json` and keep a derived `amount_inr` column for all detector maths. An unknown currency → a warning and a 1:1 rate, so the risk is visible on the alert.
- [ ] **R1-07 Timezone mixing skews the 30/60-minute windows.** Values without an offset are read as UTC, but Indian exports are usually IST. A login file with `Z` and a transaction file without an offset are 5.5 h apart, so FD-03's "transfer within 60 min after login" never fires. **Fix:** a `defaultTimezone: "+05:30"` in policy for offset-less values (or at least a file notice "times without offset read as …").
- [ ] **R1-08 Negative amounts are rejected.** Many bank exports use a signed amount (−5,000 = debit) or a `Dr/Cr` column. **Fix:** alias `dr_cr`/`debit_credit`/`txn_direction`; for a signed amount column, store `abs(amount)` with a warning, not a rejection. Keep the zero/non-numeric rejection. Also accept `$`, `USD 500`, `500 Dr`, `(500)`.
- [ ] **R1-09 `device_id` is mandatory for login events.** Some auth logs only have IP or user agent. **Fix:** if absent, derive `device_id = "ua:" + hash(user_agent)` when a user_agent column exists; otherwise null with a warning (with R1-01 a null never links customers). Don't reject.
- [ ] **R1-10 Upload limit gives an opaque error.** Vercel rejects bodies over 4.5 MB before the route runs, and the UI shows a generic failure. **Fix:** check `file.size` client-side and show "File over 4.5 MB: split it or use the sample loader". No server work needed.

### P2 — after Level 1

- [ ] **R1-11** JSON: support NDJSON and one level of nesting (`{data:{transactions:[…]}}`), and flatten nested objects to `a_b` keys before alias lookup.
- [ ] **R1-12** Excel: if row 1 has fewer than 2 non-empty cells, look for the header in the first 5 rows (title rows above the table are common).
- [ ] **R1-13** CSV encoding: detect a UTF-16 BOM and decode accordingly; Excel's "Unicode text" export breaks headers today.

### Schema additions that raise detection quality (Level 2 candidates)
All optional, with no new mandatory fields and no new UI friction. Each one feeds a specific signal or lookalike mitigation.

| Table | Column | Why it helps |
|---|---|---|
| customers | `segment` (`retail\|business\|nri`) | Business customers are a known lookalike class; this lets them get a mitigation from the declared segment, not only from history |
| customers | `risk_rating`, `pep_flag` | A precomputed KYC risk becomes one weighted signal |
| accounts | `expected_monthly_turnover` | A baseline for new accounts with no history; fixes the NO_HISTORY_LARGE cold-start issue |
| transactions | `balance_after` | Exact drain detection (balance → ~0) without needing inflows in the file |
| transactions | `beneficiary_bank` / `ifsc`, `beneficiary_added_at` | A beneficiary added minutes earlier is a strong ATO marker; works even when the login file is missing |
| transactions | `device_id`, `ip_address` on the transaction | Links a transfer to the session that made it; makes FD-03 → FD-01 chaining exact instead of time-window-based |
| transactions | `auth_method` (`otp\|biometric\|password\|none`) | A large transfer with weak auth is a signal; biometric is a mitigation |
| transactions | `merchant_category` (MCC) | Cleaner hub detection than degree alone |
| login_events | `user_agent`, `failure_reason`, `session_id` | Device fallback (R1-09); `failure_reason=wrong_otp` vs `wrong_password` tells SIM-swap apart from a forgotten password |
| login_events | `is_emulator` / `is_rooted` | Cheap, high-precision device-risk signal when present |

---

## How to respond
The builder ticks items and adds the commit hash, e.g. `- [x] R1-01 … (fixed in abc1234)`. The reviewer pulls, re-verifies, and opens Review 2.
