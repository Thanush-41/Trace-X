import { HttpError } from "@/lib/api";
import { listActions } from "@/lib/actions";
import { getCase } from "@/lib/cases";
import { explainGrouping, listSplits } from "@/lib/consolidation";
import { buildCaseGraph } from "@/lib/graph";
import { scoreCase } from "@/lib/priority";
import { listAssessments, trustReport } from "@/lib/agent/store";
import { resolveRefs } from "@/lib/queries";
import type { Ref } from "@/lib/detect/types";
import { sha256 } from "@/lib/util/hash";
import { renderPdf, type PdfLine } from "@/lib/pdf";

/** Structured case report. Every reference in it is re-resolved against the database when the report is built. */
export async function buildReport(caseId: string, generatedBy: string) {
  const data = await getCase(caseId);
  if (!data) throw new HttpError(404, "Case not found");
  const { case: c, alerts, decisions, timeline, rows } = data;
  const [scores, grouping, graph, actions, splits, assessments, trust] = await Promise.all([
    scoreCase(c, alerts, rows), explainGrouping(alerts), buildCaseGraph(alerts), listActions(caseId), listSplits(caseId), listAssessments(caseId), trustReport(),
  ]);
  const refs = new Map<string, Ref>();
  const collect = (r: Ref) => refs.set(`${r.table}:${r.id}`, r);
  alerts.forEach((a) => { collect(a.primary_ref); a.evidence.forEach(collect); });
  graph.edges.forEach((e) => e.evidence.forEach(collect));
  assessments.forEach((a) => a.assessment.tool_calls.forEach((t) => t.evidence.forEach(collect)));
  const resolved = await resolveRefs([...refs.values()]);
  const evidence_index = [...refs.values()].map((r) => {
    const row = resolved.get(`${r.table}:${r.id}`);
    return { ref: `${r.table}:${r.id}`, exists: !!row, source_file: row?.source_file ?? null, source_row: row?.source_row ?? null, row_hash: row?.row_hash ?? null };
  });
  const latest = assessments[0];
  const category = latest?.assessment.predicted_category;
  const report = {
    report_version: "1.0", generated_at: new Date().toISOString(), generated_by: generatedBy,
    case: { id: c.case_id, title: c.title, status: c.status, category: c.category, current_category: c.current_category, level: c.level, current_level: c.current_level, score: c.score, opened_at: c.created_at, first_run_id: c.first_run_id, primary_customer_id: c.primary_customer_id, primary_account_id: c.primary_account_id },
    scores: { risk: scores.risk, confidence: scores.confidence, exposure: scores.exposure, priority: scores.priority, agent_trust: category ? (({ category: cat, trust: t, level_name, n }) => ({ category: cat, trust: t, autonomy: level_name, feedback_count: n }))(trust.find((t) => t.category === category)!) : null, note: "Risk, confidence, exposure and agent trust are separate measures." },
    indicators: scores.indicators,
    alerts: alerts.map((a) => ({ alert_id: a.alert_id, detector: a.detector, level: a.level, score: a.score, title: a.title, signals: a.signals, mitigations: a.mitigations, primary_ref: a.primary_ref, evidence: a.evidence, created_at: a.created_at })),
    consolidation: grouping, splits,
    timeline: timeline.map((e) => ({ time: e.time, kind: e.kind, role: e.role, system: e.system, summary: e.summary, ref: e.ref })),
    graph: { nodes: graph.nodes.map(({ id, type, label, risk, hub, bridge, suspicious, alerts: al }) => ({ id, type, label, risk, hub, bridge, suspicious, alerts: al })), edges: graph.edges.map(({ id, source, target, type, label, evidence, evidence_count, first, last, amount, suspicious, alerts: al, why }) => ({ id, source, target, type, label, evidence, evidence_count, first, last, amount, suspicious, alerts: al, why })) },
    decisions, actions, agent_assessments: assessments, evidence_index,
    audit: { workspace_note: "Alerts, decisions, actions, splits and feedback are append-only; this report is a read-only view.", unresolved_references: evidence_index.filter((e) => !e.exists).length },
  };
  return { ...report, integrity: { sha256: sha256(JSON.stringify({ ...report, generated_at: null })) } };
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export function reportPdf(r: Report): Buffer {
  const L: PdfLine[] = [];
  const h = (t: string) => L.push({ text: t, size: 12, bold: true, gap: 10 });
  const p = (t: string) => L.push({ text: t });
  L.push({ text: "TRACE X - Fraud Case Report", size: 16, bold: true });
  p(`${r.case.id}  |  ${r.case.status}  |  generated ${r.generated_at} by ${r.generated_by}`);
  L.push({ text: r.case.title, size: 11, bold: true, gap: 4 });
  h("Scores (kept separate)");
  p(`Risk: ${r.scores.risk.level} (${r.scores.risk.score}/100)   Confidence: ${Math.round(r.scores.confidence.score * 100)}%   Exposure: ${inr(r.scores.exposure.inr)}   Priority: ${r.scores.priority.tier} (${r.scores.priority.score})`);
  p(r.scores.agent_trust ? `Agent trust (${r.scores.agent_trust.category}): ${r.scores.agent_trust.trust.toFixed(3)} from ${r.scores.agent_trust.feedback_count} validated decision(s); autonomy ${r.scores.agent_trust.autonomy}` : "Agent trust: no assessment yet");
  p(r.scores.priority.reason);
  h("Why these alerts are one case");
  p(r.consolidation.summary);
  for (const s of r.consolidation.shared.slice(0, 12)) p(`- ${s.label} [${s.field}] links ${[...new Set(s.alerts.map((a) => a.detector))].join(", ")} (${s.alerts.length} alerts)${s.timed ? (s.within_window ? ` (within ${r.consolidation.window_days} days)` : " (outside window)") : ""}`);
  h(`Alerts (${r.alerts.length})`);
  for (const a of r.alerts) {
    p(`${a.alert_id}  ${a.detector}  ${a.level} ${a.score}  ${a.title}`);
    for (const s of a.signals.filter((x) => x.weight > 0).slice(0, 5)) p(`    + ${s.label} (+${s.weight}): ${s.detail}`);
    for (const m of a.mitigations.slice(0, 3)) p(`    - ${m.label} (-${m.weight}): ${m.detail}`);
  }
  h(`Timeline (${r.timeline.length} events)`);
  for (const e of r.timeline.filter((x) => x.role !== "baseline").slice(0, 60)) p(`${e.time.slice(0, 16).replace("T", " ")}  [${e.role ?? ""}] ${e.kind}: ${e.summary}  (${e.ref.table}:${e.ref.id})`);
  h(`Relationship graph (${r.graph.nodes.length} entities, ${r.graph.edges.length} links; every link cites source records)`);
  for (const e of r.graph.edges.filter((x) => x.suspicious).slice(0, 25)) p(`${e.source} -[${e.type}]-> ${e.target}  evidence: ${e.evidence.slice(0, 3).map((x) => `${x.table}:${x.id}`).join(", ")}${e.evidence_count > 3 ? ` (+${e.evidence_count - 3})` : ""}`);
  h("Agent assessment");
  const a = r.agent_assessments[0]?.assessment;
  if (!a) p("The agent has not been run on this case.");
  else {
    p(`Predicted category: ${a.predicted_category} (evidence confidence ${Math.round(a.confidence * 100)}%); ${a.verification.claims_verified}/${a.verification.claims_total} claims verified against records; mode ${a.mode}.`);
    for (const t of a.tool_calls) p(`  tool ${t.tool}: ${t.summary}`);
    for (const x of a.recommended_actions) p(`  recommend ${x.label}${x.customer_impacting ? " [customer-impacting: requires authorised approval]" : ""}: ${x.rationale}`);
    for (const m of a.missing_information) p(`  missing: ${m.item}`);
  }
  h(`Decisions and actions (${r.decisions.length + r.actions.length})`);
  for (const d of r.decisions) p(`${d.created_at.slice(0, 16).replace("T", " ")}  ${d.decision}  by ${d.analyst}${d.note ? `: ${d.note}` : ""}`);
  for (const x of r.actions) p(`${x.created_at.slice(0, 16).replace("T", " ")}  ${x.label} [${x.effective_status}] by ${x.actor}${x.reason ? `: ${x.reason}` : ""}`);
  h("Evidence index");
  p(`${r.evidence_index.length} referenced records, ${r.audit.unresolved_references} unresolved. Integrity hash ${r.integrity.sha256.slice(0, 16)}.`);
  for (const e of r.evidence_index.slice(0, 80)) p(`${e.ref}  ${e.exists ? "found" : "MISSING"}${e.source_file ? `  ${e.source_file}:${e.source_row}` : ""}`);
  return renderPdf(`TRACE X ${r.case.id}`, L);
}
