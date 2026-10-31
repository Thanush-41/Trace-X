"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseGraph as Graph, GraphEdge, GraphNode, NodeType, System } from "@/lib/graph";
import { cx, fmtTime, inputClass } from "@/components/ui";
import { refAnchor } from "@/components/evidence";

const TYPE_STYLE: Record<NodeType, { color: string; shape: string; label: string }> = {
  customer: { color: "#2563eb", shape: "ellipse", label: "Customer" },
  account: { color: "#475569", shape: "round-rectangle", label: "Account" },
  external_account: { color: "#b45309", shape: "diamond", label: "External account" },
  device: { color: "#7c3aed", shape: "hexagon", label: "Device" },
  ip: { color: "#0e7490", shape: "tag", label: "IP address" },
  phone: { color: "#be185d", shape: "round-tag", label: "Phone" },
  email: { color: "#be185d", shape: "round-tag", label: "Email" },
  national_id: { color: "#be185d", shape: "round-tag", label: "National ID" },
  loan_application: { color: "#15803d", shape: "round-rectangle", label: "Loan application" },
  claim: { color: "#c2410c", shape: "round-rectangle", label: "Insurance claim" },
  policy: { color: "#9a3412", shape: "barrel", label: "Policy" },
  provider: { color: "#78716c", shape: "round-pentagon", label: "Provider" },
  document: { color: "#78716c", shape: "vee", label: "Invoice" },
};
const SYSTEMS: { id: System | ""; label: string }[] = [{ id: "", label: "All products" }, { id: "banking", label: "Core banking" }, { id: "lending", label: "Lending" }, { id: "insurance", label: "Insurance" }, { id: "digital", label: "Digital channel" }, { id: "identity", label: "Identity" }];
const RISK_RANK = { Low: 1, Medium: 2, High: 3 } as const;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

type Selected = { kind: "node"; node: GraphNode } | { kind: "edge"; edge: GraphEdge } | null;

/** Interactive, evidence-backed relationship graph. Every link carries the source records that created it. */
export function CaseGraph({ graph, caseId, height = 560 }: { graph: Graph; caseId: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [types, setTypes] = useState<Set<NodeType>>(() => new Set(graph.nodes.map((n) => n.type)));
  const [system, setSystem] = useState<System | "">("");
  const [risk, setRisk] = useState<"" | "Medium" | "High">("");
  const [entity, setEntity] = useState("");
  const [suspiciousOnly, setSuspiciousOnly] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const present = useMemo(() => [...new Set(graph.nodes.map((n) => n.type))], [graph]);

  const nodeMap = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const edgeMap = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph]);

  useEffect(() => {
    if (!host.current) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim() || "#0f172a";
    const muted = css.getPropertyValue("--ink-3").trim() || "#64748b";
    const surface = css.getPropertyValue("--surface").trim() || "#ffffff";
    const high = css.getPropertyValue("--risk-high").trim() || "#dc2626";
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({ data: { id: n.id, label: n.label.length > 22 ? `${n.label.slice(0, 20)}…` : n.label, type: n.type, hub: n.hub ? 1 : 0, bridge: n.bridge ? 1 : 0, suspicious: n.suspicious ? 1 : 0, risk: n.risk ?? "" } })),
      ...graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, label: e.amount ? `${e.label} ${inr(e.amount)}` : e.label, suspicious: e.suspicious ? 1 : 0, flow: ["TRANSFER", "DISBURSEMENT", "PAYOUT_TO"].includes(e.type) ? 1 : 0 } })),
    ];
    const instance = cytoscape({
      container: host.current, elements, wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 3,
      style: [
        { selector: "node", style: { label: "data(label)", "font-size": 10, color: ink, "text-valign": "bottom", "text-margin-y": 4, "background-color": "#64748b", width: 26, height: 26, "border-width": 2, "border-color": surface, "text-wrap": "none" } },
        ...(Object.entries(TYPE_STYLE) as [NodeType, (typeof TYPE_STYLE)[NodeType]][]).map(([t, s]) => ({ selector: `node[type = "${t}"]`, style: { "background-color": s.color, shape: s.shape as never } })),
        { selector: "node[suspicious = 1]", style: { "border-color": high, "border-width": 3 } },
        { selector: "node[bridge = 1]", style: { width: 34, height: 34, "border-style": "double", "border-width": 5 } },
        { selector: "node[hub = 1]", style: { opacity: 0.45, "border-style": "dashed" } },
        { selector: "edge", style: { width: 1.5, "line-color": muted, "target-arrow-color": muted, "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", "font-size": 8, color: muted, "text-rotation": "autorotate", "text-background-color": surface, "text-background-opacity": 0.85, "text-background-padding": "2px" } },
        { selector: "edge[flow = 1]", style: { width: 2.5 } },
        { selector: ".hl edge[suspicious = 1], edge.susp", style: { "line-color": high, "target-arrow-color": high, width: 3.5, color: high } },
        { selector: ".faded", style: { opacity: 0.12 } },
        { selector: ":selected", style: { "overlay-color": "#2563eb", "overlay-opacity": 0.2, "overlay-padding": 8 } },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, padding: 30 } as never,
    });
    instance.on("tap", "node", (ev) => setSelected({ kind: "node", node: nodeMap.get(ev.target.id())! }));
    instance.on("tap", "edge", (ev) => setSelected({ kind: "edge", edge: edgeMap.get(ev.target.id())! }));
    instance.on("tap", (ev) => { if (ev.target === instance) setSelected(null); });
    cy.current = instance;
    return () => { instance.destroy(); cy.current = null; };
  }, [graph, nodeMap, edgeMap]);

  // Filters and highlighting only change visibility and style; they never add or remove links.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.batch(() => {
      const edgeOk = (e: GraphEdge) => {
        if (system && e.system !== system) return false;
        if (suspiciousOnly && !e.suspicious) return false;
        if (from && (e.last ?? "9999") < from) return false;
        if (to && (e.first ?? "0000") > `${to}T23:59:59`) return false;
        return true;
      };
      const nodeOk = (n: GraphNode) => types.has(n.type) && (!risk || (n.risk && RISK_RANK[n.risk] >= RISK_RANK[risk])) && (!entity || `${n.label} ${n.id} ${n.detail}`.toLowerCase().includes(entity.toLowerCase()));
      const visibleNodes = new Set<string>();
      for (const n of graph.nodes) {
        const el = c.getElementById(n.id);
        const ok = nodeOk(n);
        el.style("display", ok ? "element" : "none");
        if (ok) visibleNodes.add(n.id);
      }
      for (const e of graph.edges) {
        const el = c.getElementById(e.id);
        el.style("display", edgeOk(e) && visibleNodes.has(e.source) && visibleNodes.has(e.target) ? "element" : "none");
      }
      if (system || from || to || suspiciousOnly) {
        for (const n of graph.nodes) {
          const connected = c.getElementById(n.id).connectedEdges().some((x) => x.style("display") !== "none");
          if (!connected && n.type !== "customer") c.getElementById(n.id).style("display", "none");
        }
      }
      c.elements().toggleClass("faded", false);
      c.elements().toggleClass("susp", false);
      if (highlight) {
        c.elements("edge[suspicious = 1]").addClass("susp");
        c.elements("node[suspicious = 0], edge[suspicious = 0]").addClass("faded");
      }
    });
  }, [graph, types, system, risk, entity, suspiciousOnly, highlight, from, to]);

  const toggleType = (t: NodeType) => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const records = graph.records;
  const showRecord = (key: string) => {
    const r = records[key];
    if (!r) return "(record not loaded)";
    const keep = ["timestamp", "submitted_at", "opened_at", "onboarding_date", "amount", "requested_amount", "claim_amount", "customer_id", "account_id", "beneficiary_account", "device_id", "ip_address", "outcome", "event_type", "status", "payout_account", "policy_id", "source_file", "source_row"];
    return keep.filter((k) => r[k] !== null && r[k] !== undefined && r[k] !== "").map((k) => `${k}: ${String(r[k])}`).join(" · ");
  };
  const evidenceList = (refs: { table: string; id: string }[], total: number) => (
    <ul className="mt-1 space-y-1">
      {refs.map((r) => (
        <li key={`${r.table}:${r.id}`} className="rounded border border-line px-2 py-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-ink">{r.table}:{r.id}</span>
            <Link href={`/cases/${caseId}#${refAnchor(r as never)}`} className="text-[11px] text-accent-ink hover:underline">source record</Link>
            <Link href={`/cases/${caseId}#tl-${refAnchor(r as never)}`} className="text-[11px] text-accent-ink hover:underline">in timeline</Link>
          </div>
          <div className="mt-0.5 break-words text-[11px] text-ink-3">{showRecord(`${r.table}:${r.id}`)}</div>
        </li>
      ))}
      {total > refs.length && <li className="text-[11px] text-ink-3">+{total - refs.length} more records back this link</li>}
    </ul>
  );
  const alertLinks = (ids: string[]) => ids.length ? (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">Linked alerts: {ids.map((a) => <Link key={a} href={`/alerts/${a}`} className="font-mono text-accent-ink hover:underline">{a}</Link>)}</div>
  ) : <p className="mt-2 text-xs text-ink-3">No alert cites this directly; it is context from the source records.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3 text-xs">
        <label className="block"><span className="mb-1 block text-ink-2">Find entity</span><input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="ID, name, account…" className={cx(inputClass, "w-40")} /></label>
        <label className="block"><span className="mb-1 block text-ink-2">Product</span><select value={system} onChange={(e) => setSystem(e.target.value as System | "")} className={inputClass}>{SYSTEMS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-ink-2">Min risk</span><select value={risk} onChange={(e) => setRisk(e.target.value as "" | "Medium" | "High")} className={inputClass}><option value="">Any</option><option>Medium</option><option>High</option></select></label>
        <label className="block"><span className="mb-1 block text-ink-2">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} /></label>
        <label className="block"><span className="mb-1 block text-ink-2">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} /></label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} className="accent-[var(--accent)]" />Highlight suspicious paths</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={suspiciousOnly} onChange={(e) => setSuspiciousOnly(e.target.checked)} className="accent-[var(--accent)]" />Suspicious links only</label>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Entity types">
        {present.map((t) => (
          <button key={t} type="button" aria-pressed={types.has(t)} onClick={() => toggleType(t)}
            className={cx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", types.has(t) ? "border-line-strong bg-surface text-ink" : "border-line bg-surface-2 text-ink-3 line-through")}>
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_STYLE[t].color }} />{TYPE_STYLE[t].label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="relative overflow-hidden rounded-xl border border-line bg-surface">
          <div ref={host} role="img" aria-label={`Relationship graph with ${graph.nodes.length} entities and ${graph.edges.length} links`} style={{ height }} className="w-full" />
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-surface/90 px-2 py-1 text-[10px] text-ink-3">Red outline: raised an alert · double ring: bridges systems · dashed: hub (not expanded) · red line: evidence of an alert · scroll to zoom, drag to pan</div>
        </div>
        <aside className="max-h-[560px] overflow-auto rounded-xl border border-line bg-surface p-3 text-sm" aria-live="polite">
          {!selected && (
            <div className="space-y-2 text-ink-2">
              <p className="font-medium text-ink">Select an entity or link</p>
              <p className="text-xs">Each link lists the source records that created it. {graph.nodes.length} entities, {graph.edges.length} links{graph.truncated ? " (largest suspicious subset shown)" : ""}.</p>
              <p className="text-xs">Time-aware: every link has first and last seen times, so use From / To to see how the network formed.</p>
            </div>
          )}
          {selected?.kind === "node" && (
            <div>
              <div className="flex items-center gap-2"><span aria-hidden className="h-3 w-3 rounded-full" style={{ background: TYPE_STYLE[selected.node.type].color }} /><span className="text-xs uppercase tracking-wide text-ink-3">{TYPE_STYLE[selected.node.type].label}</span></div>
              <p className="mt-1 break-all font-mono text-sm font-semibold">{selected.node.label}</p>
              <p className="text-xs text-ink-2">{selected.node.detail}</p>
              <p className="mt-1 text-xs text-ink-3">{selected.node.risk ? `Highest alert risk: ${selected.node.risk}` : "No alert on this entity"}{selected.node.bridge ? " · bridges several systems" : ""}{selected.node.hub ? " · high-degree hub, links attenuated" : ""}</p>
              {selected.node.first && <p className="text-xs text-ink-3">Seen {fmtTime(selected.node.first)} → {fmtTime(selected.node.last)}</p>}
              {alertLinks(selected.node.alerts)}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">Connected links</p>
              <ul className="mt-1 space-y-1 text-xs">
                {graph.edges.filter((e) => e.source === selected.node.id || e.target === selected.node.id).slice(0, 14).map((e) => (
                  <li key={e.id}><button type="button" className="text-left text-accent-ink hover:underline" onClick={() => { setSelected({ kind: "edge", edge: e }); cy.current?.getElementById(e.id).select(); }}>{e.source === selected.node.id ? "→" : "←"} {e.label} {nodeMap.get(e.source === selected.node.id ? e.target : e.source)?.label}</button></li>
                ))}
              </ul>
              {selected.node.refs.length > 0 && (<><p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">Source records</p>{evidenceList(selected.node.refs.slice(0, 8), selected.node.refs.length)}</>)}
            </div>
          )}
          {selected?.kind === "edge" && (
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-3">{selected.edge.type.replace(/_/g, " ")} · {selected.edge.system}</p>
              <p className="mt-1 text-sm font-semibold">{nodeMap.get(selected.edge.source)?.label} → {nodeMap.get(selected.edge.target)?.label}</p>
              <p className="text-xs text-ink-2">Matched on <span className="font-mono">{selected.edge.why}</span></p>
              {selected.edge.amount !== null && <p className="mt-1 text-sm">{inr(selected.edge.amount)} across {selected.edge.evidence_count} record(s)</p>}
              <p className="text-xs text-ink-3">{fmtTime(selected.edge.first)} → {fmtTime(selected.edge.last)}</p>
              {alertLinks(selected.edge.alerts)}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">Evidence</p>
              {evidenceList(selected.edge.evidence, selected.edge.evidence_count)}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
