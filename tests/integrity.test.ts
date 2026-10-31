import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { all, getDb, resetWorkspace } from "@/lib/db/client";
import { loadSample } from "@/lib/ingest/samples";
import { detect, runDetection } from "@/lib/detect/run";
import type { Ref } from "@/lib/detect/types";

const truth = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "samples", "seed-1", "ground_truth.json"), "utf8"));
const item = (id: string) => truth.items.find((i: { id: string }) => i.id === id);
const PK: Record<Ref["table"], string> = {
  customers: "customer_id", accounts: "account_id", transactions: "transaction_id", login_events: "event_id", loan_applications: "application_id", insurance_claims: "claim_id",
};

describe("detection integrity", () => {
  beforeAll(async () => {
    await resetWorkspace();
    await loadSample(1);
  });

  it("re-running detection on unchanged data adds no alerts or cases", async () => {
    const first = await runDetection();
    expect(first.new_alerts).toBe(first.total_alerts);
    expect(first.new_cases).toBe(first.total_cases);
    const alertsBefore = await all("SELECT alert_id FROM alerts");
    const second = await runDetection();
    expect(second.new_alerts).toBe(0);
    expect(second.new_cases).toBe(0);
    expect(second.input_hash).toBe(first.input_hash);
    expect(await all("SELECT alert_id FROM alerts")).toHaveLength(alertsBefore.length);
    expect(await all("SELECT * FROM detection_runs")).toHaveLength(2);
  });

  it("every evidence reference resolves to an imported record", async () => {
    const alerts = await all<{ evidence_refs_json: string; primary_ref: string }>("SELECT evidence_refs_json, primary_ref FROM alerts");
    const refs = alerts.flatMap((a) => [...(JSON.parse(a.evidence_refs_json) as Ref[]), JSON.parse(a.primary_ref) as Ref]);
    const byTable = new Map<string, Set<string>>();
    for (const r of refs) {
      if (!byTable.has(r.table)) byTable.set(r.table, new Set());
      byTable.get(r.table)!.add(r.id);
    }
    for (const [table, ids] of byTable) {
      const found = new Set((await all<{ id: string }>(`SELECT ${PK[table as Ref["table"]]} AS id FROM ${table}`)).map((r) => r.id));
      const missing = [...ids].filter((id) => !found.has(id));
      expect(missing, `missing ${table}`).toEqual([]);
    }
  });

  it("stored alerts cannot be modified", async () => {
    const db = await getDb();
    await expect(db.execute("UPDATE alerts SET level = 'Low'")).rejects.toThrow(/immutable/);
  });

  it("removing the bridging transfer breaks the cross-system link but keeps the takeover High", async () => {
    const victim = item("S6-ATO").entities.customer_ids[0];
    const bridge = item("S6-TXN").entities.transaction_ids[0];
    const before = await detect();
    expect(before.findings.some((f) => f.detector === "FD-06" && f.entities.customers.has(victim))).toBe(true);

    const db = await getDb();
    await db.execute({ sql: "DELETE FROM transactions WHERE transaction_id = ?", args: [bridge] });
    const after = await detect();
    expect(after.findings.some((f) => f.detector === "FD-06" && f.entities.customers.has(victim))).toBe(false);
    const ato = after.findings.find((f) => f.detector === "FD-03" && f.entities.customers.has(victim));
    expect(ato?.level).toBe("High");
    expect(ato?.signals.some((s) => s.code === "OUTBOUND_AFTER")).toBe(false);
    // The loan ring is still detected on its own.
    expect(after.findings.some((f) => f.detector === "FD-05" && f.level === "High")).toBe(true);
  });
});
