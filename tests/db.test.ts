import { describe, expect, it } from "vitest";
import { getDb, all, resetWorkspace } from "@/lib/db/client";

const alertRow = (id: string) => ({
  sql: `INSERT INTO alerts (alert_id, fingerprint, first_run_id, detector, category, subject_type, subject_id, title,
    customer_ids, account_ids, transaction_ids, device_ids, application_ids, products, event_time, primary_ref,
    raw_score, score, level, signals_json, mitigations_json, evidence_refs_json, created_at)
    VALUES (?, ?, 'RUN-1', 'FD-01', 'Suspicious transfer', 'transaction', 'T1', 't', '[]','[]','[]','[]','[]','[]',
    '2026-10-01T00:00:00Z', '{}', 50, 50, 'Medium', '[]', '[]', '[]', '2026-10-01T00:00:00Z')`,
  args: [id, `fp-${id}`],
});

describe("database integrity", () => {
  it("creates every table", async () => {
    const tables = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.map((t) => t.name);
    for (const t of ["customers", "accounts", "transactions", "login_events", "loan_applications", "alerts", "cases", "case_decisions"]) {
      expect(names).toContain(t);
    }
  });

  it("alerts cannot be updated or deleted", async () => {
    const db = await getDb();
    await db.execute(alertRow("A1"));
    await expect(db.execute("UPDATE alerts SET score = 0 WHERE alert_id = 'A1'")).rejects.toThrow(/immutable/);
    await expect(db.execute("DELETE FROM alerts WHERE alert_id = 'A1'")).rejects.toThrow(/immutable/);
    const [row] = await all<{ score: number }>("SELECT score FROM alerts WHERE alert_id = 'A1'");
    expect(row.score).toBe(50);
  });

  it("duplicate fingerprints are ignored, not duplicated", async () => {
    const db = await getDb();
    await db.execute({ ...alertRow("A2"), sql: alertRow("A2").sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") });
    const dup = alertRow("A3");
    dup.args = ["A3", "fp-A2"];
    await db.execute({ ...dup, sql: dup.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") });
    const rows = await all("SELECT alert_id FROM alerts WHERE fingerprint = 'fp-A2'");
    expect(rows).toHaveLength(1);
  });

  it("case decisions are append-only", async () => {
    const db = await getDb();
    await db.execute(`INSERT INTO case_decisions (case_id, decision, analyst, created_at) VALUES ('C1','FALSE_POSITIVE','ana','2026-10-01')`);
    await expect(db.execute("UPDATE case_decisions SET decision = 'ESCALATED'")).rejects.toThrow(/append-only/);
  });

  it("reset clears everything and keeps triggers", async () => {
    await resetWorkspace();
    expect(await all("SELECT * FROM alerts")).toHaveLength(0);
    const db = await getDb();
    await db.execute(alertRow("A9"));
    await expect(db.execute("DELETE FROM alerts")).rejects.toThrow(/immutable/);
  });
});
