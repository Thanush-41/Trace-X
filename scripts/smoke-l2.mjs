/**
 * Level 2 end-to-end check against a running TRACE X. Uses its own local database: start the server with
 *   TRACEX_DB_URL=file:/some/scratch.db npm run dev
 * It resets that workspace, so non-local URLs are refused unless --allow-reset is passed.
 *
 *   node scripts/smoke-l2.mjs http://localhost:3000 [seed]
 */
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const base = (positional[0] ?? "http://localhost:3000").replace(/\/$/, "");
const seed = Number(positional[1] ?? 3);
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base) && !process.argv.includes("--allow-reset")) { console.error("Refusing to reset a hosted workspace; pass --allow-reset to override."); process.exit(2); }
let cookie = "", failures = 0;
const check = (l, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? `  (${d})` : ""}`); if (!ok) failures++; };
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";", 1)[0];
  const buf = Buffer.from(await res.arrayBuffer());
  let json; try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
  return { status: res.status, json, buf, text: buf.toString("latin1") };
}
const login = async (u) => { cookie = ""; const r = await call("POST", "/api/auth/login", { username: u, password: "agentio@123" }); check(`login ${u}`, r.status === 200); };

await login("thanushgarimella@gmail.com");
check("reset", (await call("POST", "/api/reset", { confirm: "RESET" })).status === 200);
check(`load seed ${seed}`, (await call("POST", "/api/samples/load", { seed })).status < 300);
const det = await call("POST", "/api/detect");
check("detect", det.status < 300, `${det.json?.total_cases} cases`);
const cases = (await call("GET", "/api/cases?status=open")).json.cases;
check("cases listed", cases.length > 0);
const cross = cases.find((c) => /linked alerts across/.test(c.title)) ?? cases[0];
const id = cross.case_id;

const graph = await call("GET", `/api/cases/${id}/graph`);
check("graph: nodes and edges", graph.json.nodes.length > 3 && graph.json.edges.length > 3, `${graph.json.nodes.length} nodes / ${graph.json.edges.length} edges`);
check("graph: every edge cites records", graph.json.edges.every((e) => e.evidence.length > 0 && e.evidence.every((r) => graph.json.records[`${r.table}:${r.id}`])));
const grp = await call("GET", `/api/cases/${id}/grouping`);
check("grouping explained", grp.json.shared.length > 0, grp.json.summary);

const page = await call("GET", `/cases/${id}`);
check("case page renders", page.status === 200 && page.text.includes("Relationship graph") && page.text.includes("Adaptive investigation agent") && page.text.includes("Why these alerts were consolidated"));
check("agent page renders", (await call("GET", "/agent")).text.includes("Agent trust"));
check("graph page renders", (await call("GET", "/graph")).status === 200);
check("dashboard renders", (await call("GET", "/")).text.includes("Investigation priorities"));
check("evaluation renders", (await call("GET", "/evaluation")).text.includes("Agent evaluation"));

const t0 = (await call("GET", "/api/agent/trust")).json;
check("trust starts at zero everywhere", t0.categories.every((c) => c.trust === 0 && c.level === 0));
const ag = await call("POST", `/api/cases/${id}/agent`);
check("agent assessment", ag.status === 201 && ag.json.assessment.verification.claims_verified > 0, `${ag.json?.assessment?.predicted_category}`);
const fb = await call("POST", `/api/cases/${id}/agent/feedback`, { outcome: "accepted" });
check("feedback recorded", fb.status === 201, fb.json?.loop);

await login("test@agentio.com");
for (const action of ["REQUEST_INFORMATION", "RECOMMEND_HOLD", "SET_CONCLUSION"]) {
  const r = await call("POST", `/api/cases/${id}/actions`, { action, reason: "Smoke test reason text", outcome: "inconclusive" });
  check(`analyst action ${action}`, r.status === 201, r.json?.status);
}
const actions = (await call("GET", `/api/cases/${id}/actions`)).json.actions;
const hold = actions.find((a) => a.action === "RECOMMEND_HOLD");
check("hold stays a recommendation", hold.effective_status === "pending_approval");
check("analyst cannot approve a hold", (await call("POST", `/api/cases/${id}/actions/${hold.id}/approval`, { outcome: "approved", reason: "analyst trying" })).status === 403);
check("analyst cannot use admin controls", (await call("POST", "/api/agent/settings", { kill_switch: true })).status === 403);
await login("thanushgarimella@gmail.com");
const ap = await call("POST", `/api/cases/${id}/actions/${hold.id}/approval`, { outcome: "approved", reason: "Supervisor reviewed exposure" });
check("supervisor approves the analyst's recommendation", ap.status === 201, `status ${ap.status}`);
check("approval does not execute anything", (await call("GET", `/api/agent/trust`)).json.actions.length === 0);

const members = grp.json.per_alert.map((p) => p.alert_id);
if (members.length > 1) {
  const sp = await call("POST", `/api/cases/${id}/split`, { alert_ids: [members[0]], reason: "Smoke test split of one alert" });
  check("split case", sp.status === 201, sp.json?.to_case_id);
  await call("POST", "/api/detect");
  const after = await call("GET", `/api/cases/${sp.json.to_case_id}/grouping`);
  check("split survives a re-run", after.status === 200 && after.json.per_alert.some((p) => p.alert_id === members[0]));
}
const pdf = await call("GET", `/api/cases/${id}/report?format=pdf`);
check("PDF report", pdf.status === 200 && pdf.text.startsWith("%PDF-") && pdf.buf.length > 2000, `${pdf.buf.length} bytes`);
const rep = await call("GET", `/api/cases/${id}/report`);
check("JSON report resolves every reference", rep.json.audit.unresolved_references === 0, `${rep.json.evidence_index.length} refs`);
const rp = await call("POST", "/api/agent/replay", { seeds: [seed] });
check("answer-key replay", rp.status === 200, `${rp.json?.results?.length} cases`);
const ev = (await call("GET", "/api/agent/evaluation")).json;
check("agent evaluation computed", ev.feedback.total > 3 && ev.autonomous_safety.allowlist_violations === 0, `${ev.feedback.total} decisions, accuracy ${ev.agent_correctness.accuracy}%`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
