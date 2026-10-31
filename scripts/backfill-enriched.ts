/**
 * Fills the enriched columns (session telemetry, payee-name check) on an existing workspace from the same sample
 * seed's CSVs, matching rows by ID and only where the column is still empty. Nothing else is touched: alerts, cases,
 * decisions and row hashes stay as they are. Logged in the workspace activity feed.
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/backfill-enriched.ts 3
 */
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

async function main() {
  const seed = Number(process.argv[2] ?? 3);
  const { getDb, logEvent } = await import("@/lib/db/client");
  const db = await getDb();
  const read = (f: string) => Papa.parse<Record<string, string>>(fs.readFileSync(path.join("data", "samples", `seed-${seed}`, f), "utf8"), { header: true, skipEmptyLines: true }).data;
  const num = (v: string) => (v === "" || v === undefined ? null : Number(v));
  const logins = read("login_events.csv");
  const txns = read("transactions.csv");
  let n = 0;
  for (let i = 0; i < logins.length; i += 200) {
    const chunk = logins.slice(i, i + 200);
    const res = await db.batch(chunk.map((l) => ({
      sql: "UPDATE login_events SET sim_swap_days = ?, remote_access = ?, emulator_or_rooted = ?, vpn_proxy = ?, session_seconds = ?, typing_anomaly = ? WHERE event_id = ? AND sim_swap_days IS NULL",
      args: [num(l.sim_swap_days), num(l.remote_access), num(l.emulator_or_rooted), num(l.vpn_proxy), num(l.session_seconds), num(l.typing_anomaly), l.event_id],
    })), "write");
    n += res.reduce((s, r) => s + r.rowsAffected, 0);
  }
  let m = 0;
  for (let i = 0; i < txns.length; i += 200) {
    const chunk = txns.slice(i, i + 200).filter((t) => t.payee_name_check);
    if (!chunk.length) continue;
    const res = await db.batch(chunk.map((t) => ({ sql: "UPDATE transactions SET payee_name_check = ? WHERE transaction_id = ? AND payee_name_check IS NULL", args: [t.payee_name_check, t.transaction_id] })), "write");
    m += res.reduce((s, r) => s + r.rowsAffected, 0);
  }
  await logEvent("backfill", `Enriched fields filled from seed ${seed} files: ${n} login events (session telemetry), ${m} transfers (payee-name check). Run detection to use them.`, "TRACE X release (Level 2)");
  console.log(`login_events updated: ${n}; transactions updated: ${m}`);
}
main();
