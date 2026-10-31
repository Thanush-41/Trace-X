import { beforeEach, describe, expect, it } from "vitest";
import { all, resetWorkspace } from "@/lib/db/client";
import { detect } from "@/lib/detect/run";
import { ingestFile, type IngestFailure, type IngestResult } from "@/lib/ingest/load";
import { detectDateOrder, isPlaceholder, normOutcome, normProduct, parseAmount, parseTimestamp } from "@/lib/util/normalize";

const ok = (rs: (IngestResult | IngestFailure)[]) => rs.map((r) => {
  if (!r.ok) throw new Error(r.error);
  return r;
});

describe("review R1: parsing judge data", () => {
  it("R1-04 reads common date formats and per-column day/month order", () => {
    expect(parseTimestamp("2026/10/05 14:00")).toBe("2026-10-05T14:00:00.000Z");
    expect(parseTimestamp("05-Oct-2026")).toBe("2026-10-05T00:00:00.000Z");
    expect(parseTimestamp("Oct 5, 2026 3:05 PM")).toBe("2026-10-05T15:05:00.000Z");
    expect(parseTimestamp("25/10/2026 03:05 pm")).toBe("2026-10-25T15:05:00.000Z");
    expect(parseTimestamp("10/25/2026")).toBe("2026-10-25T00:00:00.000Z");
    expect(parseTimestamp("03/04/2026", { order: "MDY" })).toBe("2026-03-04T00:00:00.000Z");
    expect(parseTimestamp("03/04/2026", { order: "DMY" })).toBe("2026-04-03T00:00:00.000Z");
    expect(parseTimestamp("2026-10-05 10:00 +05:30")).toBe("2026-10-05T04:30:00.000Z");
    expect(parseTimestamp("2026-10-05T10:00:00+0530")).toBe("2026-10-05T04:30:00.000Z");
    expect(parseTimestamp("1760000000")).toBe("2025-10-09T08:53:20.000Z");
    expect(parseTimestamp(1760000000000)).toBe("2025-10-09T08:53:20.000Z");
    expect(parseTimestamp("2026-10-05 10:00", { defaultOffset: "+05:30" })).toBe("2026-10-05T04:30:00.000Z");
    expect(parseTimestamp("2026-10-05", { defaultOffset: "+05:30" })).toBe("2026-10-05T00:00:00.000Z");
    expect(parseTimestamp("13:00 PM 2026-10-05")).toBeNull();
    expect(detectDateOrder(["10/25/2026", "03/04/2026"]).order).toBe("MDY");
    expect(detectDateOrder(["25/10/2026", "03/04/2026"]).order).toBe("DMY");
    expect(detectDateOrder(["03/04/2026"]).ambiguous).toBe(true);
  });

  it("R1-05 understands login outcome vocabulary", () => {
    for (const v of ["Y", "S", "LOGIN_SUCCESS", "Authenticated", "OK"]) expect(normOutcome(v), v).toBe("success");
    for (const v of ["N", "F", "AUTH_FAILED", "invalid_password", "wrong_otp", "locked", "BLOCKED", "2FA_failed", "unsuccessful"]) expect(normOutcome(v), v).toBe("failure");
    expect(normOutcome("maybe")).toBeNull();
  });

  it("R1-03 maps real product names", () => {
    expect(normProduct("personal_loan")).toBe("lending");
    expect(normProduct("Home Loan")).toBe("lending");
    expect(normProduct("mortgage")).toBe("lending");
    expect(normProduct("savings_account")).toBe("banking");
    expect(normProduct("FD")).toBe("banking");
    expect(normProduct("wallet")).toBe("banking");
    expect(normProduct("credit card")).toBe("cards");
    expect(normProduct("motor policy")).toBe("insurance");
  });

  it("R1-08 reads signed and decorated amounts", () => {
    expect(parseAmount("$500")).toBe(500);
    expect(parseAmount("USD 1,250.50")).toBe(1250.5);
    expect(parseAmount("500 Dr")).toBe(-500);
    expect(parseAmount("500 Cr")).toBe(500);
    expect(parseAmount("(500)")).toBe(-500);
  });

  it("R1-01 recognises placeholder identifiers", () => {
    for (const v of ["unknown", "NA", "N/A", "null", "-", "0", "0000000000", "xxxx", "test@test.com", "UNKNOWN_1"]) expect(isPlaceholder(v), v).toBe(true);
    for (const v of ["DEV-1A2B3C", "9876543210", "ravi@gmail.com"]) expect(isPlaceholder(v), v).toBe(false);
  });
});

describe("review R1: ingest and detect unseen data", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  it("R1-02 accepts customers without email or phone; R1-01 placeholders never form rings", async () => {
    const customers = [
      "Customer No,Name,Mobile,Email,Joined",
      ...Array.from({ length: 6 }, (_, i) => `C${i},Person ${i},${i % 2 ? "NA" : "0000000000"},${i % 2 ? "" : "test@test.com"},2026-01-0${i + 1}`),
    ].join("\n");
    const [c] = ok(await ingestFile(Buffer.from(customers), "customers.csv"));
    expect(c.accepted).toBe(6);
    expect(c.rejected).toBe(0);
    expect(c.warnings).toBeGreaterThan(0);

    const logins = [
      "login_id,cust_id,device,login_time,result",
      ...Array.from({ length: 6 }, (_, i) => `L${i},C${i},unknown,2026-02-0${i + 1} 10:00,LOGIN_SUCCESS`),
    ].join("\n");
    const [l] = ok(await ingestFile(Buffer.from(logins), "logins.csv"));
    expect(l.accepted).toBe(6);
    const out = await detect();
    expect(out.findings.filter((f) => f.detector === "FD-02" || f.detector === "FD-04")).toEqual([]);
  });

  it("R1-03/R1-06/R1-08/R1-09 accepts products, currencies, signed amounts and missing devices", async () => {
    ok(await ingestFile(Buffer.from("account_no,cust_id,product_type,open_date\nA100,C1,personal_loan,2025-01-01\nA200,C1,Savings Account,2025-01-01\nA300,C1,crypto,2025-01-01\n"), "accounts.csv"));
    const accounts = await all<{ account_id: string; product: string }>("SELECT account_id, product FROM accounts ORDER BY account_id");
    expect(accounts.map((a) => a.product)).toEqual(["lending", "banking", "banking"]);

    const [t] = ok(await ingestFile(Buffer.from("txn_id,from_account,to_account,amount,currency,date\nT1,A200,B9,-1000,USD,10/25/2026 2:30 PM\nT2,A200,B9,$50,usd,10/26/2026 9:00 AM\n"), "payments.csv"));
    expect(t.accepted).toBe(2);
    expect(t.notices.join(" ")).toMatch(/month-first/);
    const txns = await all<{ amount: number; amount_inr: number; timestamp: string }>("SELECT amount, amount_inr, timestamp FROM transactions ORDER BY transaction_id");
    expect(txns[0]).toMatchObject({ amount: 1000, amount_inr: 83000, timestamp: "2026-10-25T09:00:00.000Z" });

    const [l] = ok(await ingestFile(Buffer.from("event_id,customer_id,timestamp,outcome,user_agent\nE1,C1,2026-10-01T10:00:00Z,wrong_otp,Mozilla/5.0 (iPhone)\nE2,C1,2026-10-01T10:01:00Z,failed,\n"), "auth.csv"));
    expect(l.accepted).toBe(2);
    const devices = await all<{ device_id: string | null }>("SELECT device_id FROM login_events ORDER BY event_id");
    expect(devices[0].device_id).toMatch(/^ua:/);
    expect(devices[1].device_id).toBeNull();
  });
});

describe("ML anomaly layer", () => {
  it("isolation forest is deterministic and ranks an obvious outlier highest", async () => {
    const { IsolationForest } = await import("@/lib/detect/anomaly");
    const rows = Array.from({ length: 300 }, (_, i) => [Math.sin(i) * 0.5 + 5, Math.cos(i) * 0.5 + 3]);
    const a = new IsolationForest(50, 128, 7).fit(rows);
    const b = new IsolationForest(50, 128, 7).fit(rows);
    const normal = a.score([5, 3]);
    const outlier = a.score([12, -4]);
    expect(outlier).toBeGreaterThan(0.55);
    expect(outlier).toBeGreaterThan(normal + 0.15);
    expect(b.score([12, -4])).toBe(outlier);
  });
});
