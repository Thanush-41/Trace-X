/**
 * End-to-end smoke test of the demo flow against a running TRACE X (local or deployed).
 *
 *   node scripts/smoke.mjs http://localhost:3000 [seed]
 *
 * WARNING: resets the workspace first (deletes all data, alerts, cases and decisions).
 */
import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const seed = Number(process.argv[3] ?? 3);
const dir = path.join(process.cwd(), "data", "samples", `seed-${seed}`);
let failures = 0;

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
async function call(method, url, body, isForm = false) {
  const res = await fetch(base + url, {
    method,
    headers: body && !isForm ? { "content-type": "application/json" } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const upload = (file) => {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(path.join(dir, file))]), file);
  return call("POST", "/api/ingest", form, true);
};

await call("POST", "/api/reset", { confirm: "RESET" });

const load = await call("POST", "/api/samples/load", { seed });
const loaded = load.json.results ?? [];
check("load bundled sample", load.status === 200 && loaded.length === 5 && loaded.every((r) => r.ok && r.rejected === 0), loaded.map((r) => `${r.dataset_type}:${r.accepted}`).join(" "));

const bad = (await upload("transactions_with_errors.csv")).json.results?.[0];
check("error file: every row reported", bad && bad.total === bad.accepted + bad.rejected + bad.duplicates && bad.rejected === 4 && bad.duplicates === 1 && bad.warnings === 1,
  bad && `accepted ${bad.accepted}, rejected ${bad.rejected}, duplicates ${bad.duplicates}, warnings ${bad.warnings}`);
const again = (await upload("transactions_with_errors.csv")).json.results?.[0];
check("re-upload inserts nothing new", again && again.accepted === 0, again && `accepted ${again.accepted}, duplicates ${again.duplicates}`);

const alt = (await upload("logins_alt_headers.csv")).json.results?.[0];
check("alternate headers mapped", alt && alt.dataset_type === "login_events" && alt.accepted === 20, alt && JSON.stringify(alt.header_map));

const xlsx = (await upload("tracex.xlsx")).json.results ?? [];
check("Excel workbook recognised as duplicates", xlsx.length === 5 && xlsx.every((r) => r.ok && r.accepted === 0), xlsx.map((r) => `${r.sheet}:${r.duplicates}`).join(" "));

const run1 = (await call("POST", "/api/detect")).json;
check("detection runs", run1.total_alerts > 0 && run1.total_cases > 0, `${run1.total_alerts} findings, ${run1.by_level?.High} High, ${run1.by_level?.Medium} Medium, ${run1.total_cases} cases, ${run1.ms} ms`);

const evalRes = (await call("POST", "/api/evaluate", { seed })).json;
check("all planted fraud detected", evalRes.recall === 1, `${evalRes.fraud_detected}/${evalRes.fraud_total}`);
check("all lookalikes kept low", evalRes.lookalike_false_positive_rate === 0, `${evalRes.lookalikes_clean}/${evalRes.lookalikes_total}`);

for (const q of ["product=lending", "level=High", "detector=FD-03&view=all", "from=2026-10-01&to=2026-10-31&view=all"]) {
  const r = (await call("GET", `/api/alerts?${q}`)).json;
  check(`filter ${q}`, typeof r.total === "number" && r.total > 0 && r.total < run1.total_alerts, `${r.total}`);
}

const cases = (await call("GET", "/api/cases")).json.cases ?? [];
const cross = cases.find((c) => c.category === "Cross-system organised fraud");
check("cross-system case exists", !!cross, cross?.case_id);
if (cross) {
  const before = (await call("GET", `/api/cases/${cross.case_id}`)).json.alerts;
  const d = await call("POST", `/api/cases/${cross.case_id}/decisions`, { decision: "REQUIRES_INVESTIGATION", note: "smoke test", analyst: "smoke" });
  check("decision recorded", d.status === 201);
  const after = (await call("GET", `/api/cases/${cross.case_id}`)).json;
  check("status updated, alerts unchanged", after.case.status === "REQUIRES_INVESTIGATION" && JSON.stringify(after.alerts) === JSON.stringify(before));
}

const run2 = (await call("POST", "/api/detect")).json;
check("re-run is idempotent", run2.new_alerts === 0 && run2.new_cases === 0, `new alerts ${run2.new_alerts}, new cases ${run2.new_cases}`);

const fp = await call("POST", `/api/cases/${cases[0]?.case_id}/decisions`, { decision: "FALSE_POSITIVE", analyst: "smoke" });
check("closing without a note is refused", fp.status === 400, fp.json?.error);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
