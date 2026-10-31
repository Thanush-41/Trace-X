import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { all, resetWorkspace } from "@/lib/db/client";
import { detectType } from "@/lib/ingest/fields";
import { ingestFile, type IngestResult, type IngestFailure } from "@/lib/ingest/load";
import { loadSample } from "@/lib/ingest/samples";

const dir = path.join(process.cwd(), "data", "samples", "seed-1");
const file = (name: string) => fs.readFileSync(path.join(dir, name));
const ok = (rs: (IngestResult | IngestFailure)[]) => rs.map((r) => {
  if (!r.ok) throw new Error(r.error);
  return r;
});
const csvRows = (name: string) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n").length - 1;
const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of ["customers", "accounts", "transactions", "login_events", "loan_applications"]) {
    out[t] = Number((await all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
  }
  return out;
};

beforeEach(async () => {
  await resetWorkspace();
});

describe("ingestion", () => {
  it("loads a bundled sample: every row accepted, buckets add up", async () => {
    const results = ok(await loadSample(1));
    expect(results.map((r) => r.dataset_type)).toEqual(["customers", "accounts", "loan_applications", "login_events", "transactions"]);
    for (const r of results) {
      expect(r.rejected).toBe(0);
      expect(r.accepted + r.rejected + r.duplicates).toBe(r.total);
      expect(r.total).toBe(csvRows(`${r.dataset_type}.csv`));
    }
    expect((await counts()).transactions).toBe(csvRows("transactions.csv"));
  });

  it("re-uploading the same file inserts nothing and reports duplicates", async () => {
    await loadSample(1);
    const [again] = ok(await ingestFile(file("customers.csv"), "customers.csv"));
    expect(again.accepted).toBe(0);
    expect(again.duplicates).toBe(again.total);
  });

  it("CSV, XLSX and JSON of the same seed give identical row counts", async () => {
    await loadSample(1);
    const fromCsv = await counts();

    await resetWorkspace();
    const xlsx = ok(await ingestFile(file("tracex.xlsx"), "tracex.xlsx"));
    expect(xlsx).toHaveLength(5);
    expect(await counts()).toEqual(fromCsv);

    await resetWorkspace();
    ok(await ingestFile(file("tracex.json"), "tracex.json"));
    expect(await counts()).toEqual(fromCsv);

    // Same records in another format are recognised as duplicates, not new rows.
    const csvAgain = ok(await ingestFile(file("transactions.csv"), "transactions.csv"));
    expect(csvAgain[0].duplicates).toBe(csvAgain[0].total);
  });

  it("reports every problem in the error file and never drops a row", async () => {
    await loadSample(1);
    const [r] = ok(await ingestFile(file("transactions_with_errors.csv"), "transactions_with_errors.csv"));
    expect(r.total).toBe(7);
    expect(r.accepted).toBe(2); // valid row + unknown-accounts row (warning)
    expect(r.warnings).toBe(1);
    expect(r.rejected).toBe(4); // missing id, impossible date, negative amount, id conflict
    expect(r.duplicates).toBe(1);
    const messages = r.issues.map((i) => `${i.severity}:${i.field}:${i.message}`);
    expect(messages.some((m) => m.startsWith("error:transaction_id:transaction_id is required"))).toBe(true);
    expect(messages.some((m) => m.startsWith("error:timestamp:") && m.includes("31/02/2026"))).toBe(true);
    expect(messages.some((m) => m.startsWith("error:amount:") && m.includes("greater than 0"))).toBe(true);
    expect(messages.some((m) => m.includes("already exists with different values"))).toBe(true);
    expect(messages.some((m) => m.startsWith("warning:account_id:"))).toBe(true);
    expect(messages.some((m) => m.startsWith("duplicate:"))).toBe(true);
    const stored = await all("SELECT * FROM import_errors WHERE batch_id = ?", [r.batch_id]);
    expect(stored).toHaveLength(r.issues.length);
  });

  it("maps another system's headers and date format", async () => {
    await loadSample(1);
    const [r] = ok(await ingestFile(file("logins_alt_headers.csv"), "logins_alt_headers.csv"));
    expect(r.dataset_type).toBe("login_events");
    expect(r.header_map).toMatchObject({ "Login ID": "event_id", "Cust ID": "customer_id", "Login Time": "timestamp", "Auth Result": "outcome" });
    expect(r.accepted).toBe(20);
    expect(r.rejected).toBe(0);
  });

  it("defaults missing channel/status columns with a visible notice", async () => {
    const csv = "txn_id,from_account,to_account,amount,date\nT1,A1,B1,100,2026-10-01 10:00\n";
    const [r] = ok(await ingestFile(Buffer.from(csv), "payments.csv"));
    expect(r.dataset_type).toBe("transactions");
    expect(r.notices.join(" ")).toMatch(/channel.*unknown/);
    const [row] = await all<{ channel: string; status: string }>("SELECT channel, status FROM transactions");
    expect(row).toEqual({ channel: "unknown", status: "completed" });
  });

  it("rejects unrecognisable files with the missing columns named", async () => {
    const [r] = await ingestFile(Buffer.from("foo,bar\n1,2\n"), "random.csv");
    expect(r.ok).toBe(false);
    expect((r as IngestFailure).error).toMatch(/Unrecognised file/);
    const [bad] = await ingestFile(Buffer.from("not json"), "x.json");
    expect((bad as IngestFailure).error).toMatch(/Invalid JSON/);
    const [ext] = await ingestFile(Buffer.from(""), "x.pdf");
    expect((ext as IngestFailure).error).toMatch(/Unsupported file type/);
  });

  it("detects the dataset type from headers alone", () => {
    const t = (h: string) => {
      const d = detectType(h.split(","));
      return "error" in d ? d.error : d.type;
    };
    expect(t("customer_id,full_name,phone,email,onboarding_date")).toBe("customers");
    expect(t("account_id,customer_id,product,opened_at")).toBe("accounts");
    expect(t("application_id,customer_id,requested_amount,payout_account,submitted_at,phone,email")).toBe("loan_applications");
    expect(t("event_id,customer_id,device_id,timestamp,outcome")).toBe("login_events");
  });
});
