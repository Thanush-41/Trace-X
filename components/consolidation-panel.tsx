"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LevelBadge, Pill, buttonClass, cx, fmtTime, inputClass } from "@/components/ui";
import type { GroupingExplanation } from "@/lib/consolidation";
import type { Level } from "@/lib/policy";

type A = { alert_id: string; detector: string; title: string; level: Level; score: number };
type Split = { id: number; from_case_id: string; to_case_id: string; reason: string; actor: string; created_at: string; moved_alert_ids: string };

/** Why alerts were consolidated, and a way for the analyst to split wrongly grouped alerts into a separate case. */
export function ConsolidationPanel({ caseId, grouping, alerts, splits }: { caseId: string; grouping: GroupingExplanation; alerts: A[]; splits: Split[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const via = new Map(grouping.per_alert.map((p) => [p.alert_id, p]));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function split(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/split`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_ids: [...picked], reason }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.[0]?.message ?? body.error);
      setMsg({ ok: true, text: `Moved ${body.moved.length} alert(s) to a new case.`, href: `/cases/${body.to_case_id}` });
      setPicked(new Set()); setReason("");
      start(() => router.refresh());
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">{grouping.summary}</p>
      {grouping.shared.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-3"><tr>{["Shared entity", "Matching source field", "Linked alerts", "Time relationship"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {grouping.shared.map((s) => (
                <tr key={s.key} className="align-top">
                  <td className="px-3 py-2 font-medium">{s.label}</td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-2">{s.field}</td>
                  <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{s.alerts.map((a) => <Link key={a.alert_id} href={`/alerts/${a.alert_id}`} title={a.title}><Pill>{a.detector}</Pill></Link>)}</div></td>
                  <td className="px-3 py-2 text-xs text-ink-2">
                    {s.span_days === 0 ? "same moment" : `${s.span_days} day(s) apart`}
                    {s.timed && <span className={cx("ml-1", s.within_window ? "text-good-ink" : "text-risk-high")}>{s.within_window ? `within ${grouping.window_days}-day window` : "outside window"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {grouping.excluded_hubs.length > 0 && (
        <p className="text-xs text-ink-3">Not used for grouping (high-degree hubs): {grouping.excluded_hubs.map((h) => `${h.label} (${h.customers} customers)`).join(", ")}.</p>
      )}

      {alerts.length > 1 && (
        <form onSubmit={split} className="space-y-3 rounded-lg border border-line bg-surface-2/50 p-3">
          <h3 className="text-sm font-semibold">Split incorrectly grouped alerts</h3>
          <p className="text-xs text-ink-2">Select the alerts that do not belong with the rest. They move to a new case; the alerts, evidence and decisions are kept and a later detection run will not merge them back.</p>
          <ul className="space-y-1.5">
            {alerts.map((a) => {
              const p = via.get(a.alert_id);
              return (
                <li key={a.alert_id}>
                  <label className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.has(a.alert_id)} onChange={() => toggle(a.alert_id)} className="accent-[var(--accent)]" />
                    <LevelBadge level={a.level} score={a.score} /><Pill>{a.detector}</Pill>
                    <span className="min-w-0 flex-1">{a.title}</span>
                    {p?.weakly_connected && <Pill tone="warn" title="Only one shared entity ties this alert to the group">weak link</Pill>}
                  </label>
                  {p && <p className="ml-6 text-[11px] text-ink-3">Connected via {p.connected_via.length ? p.connected_via.slice(0, 4).join(", ") : "no shared entity found"}</p>}
                </li>
              );
            })}
          </ul>
          <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Reason (required)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} minLength={10} required className={inputClass} placeholder="Why do these alerts belong in a separate case?" /></label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || picked.size === 0} className={buttonClass("primary")}>{busy ? "Splitting…" : `Split ${picked.size || ""} alert(s) into a new case`}</button>
            {msg && <span role="status" className={cx("text-sm", msg.ok ? "text-good-ink" : "text-risk-high")}>{msg.text} {msg.href && <Link href={msg.href} className="underline">Open new case</Link>}</span>}
          </div>
        </form>
      )}

      {splits.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Analyst corrections</h3>
          <ul className="space-y-1 text-sm">
            {splits.map((s) => (
              <li key={s.id} className="rounded border border-line px-3 py-2">
                <span className="text-xs text-ink-3">{fmtTime(s.created_at)} UTC · {s.actor}</span>
                <div>{(JSON.parse(s.moved_alert_ids) as string[]).length} alert(s) {s.from_case_id === caseId ? "moved to" : "came from"} <Link href={`/cases/${s.from_case_id === caseId ? s.to_case_id : s.from_case_id}`} className="font-mono text-accent-ink hover:underline">{s.from_case_id === caseId ? s.to_case_id : s.from_case_id}</Link>: {s.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
