"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pill, buttonClass, cx, fmtTime, inputClass } from "@/components/ui";
import { refAnchor } from "@/components/evidence";
import type { Assessment, Claim } from "@/lib/agent/investigate";
import { AGENT_CATEGORIES } from "@/lib/agent/trust";

type Stored = { id: number; created_by: string; created_at: string; assessment: Assessment };
type Trust = { category: string; trust: number; level_name: string; n: number; next_step: string };
type Feedback = { lesson?: string | null; loop: string; before: { trust: number; level: number }; after: { trust: number; level: number }; category: string; split: string };
type Autonomous = { level: number; performed: string[]; blocked: string | null };

const pct = (n: number) => `${Math.round(n * 100)}%`;
const Cites = ({ claim, caseId }: { claim: Claim; caseId: string }) => (
  <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
    {claim.evidence.slice(0, 4).map((r) => <a key={`${r.table}:${r.id}`} href={`/cases/${caseId}#${refAnchor(r)}`} className="rounded border border-line px-1 font-mono text-[10px] text-accent-ink hover:bg-surface-2">{r.id}</a>)}
  </span>
);

/** The investigation agent: run it, read its verified reasoning, then accept, correct or reject it. */
export function AgentPanel({ caseId, stored, trust, feedbackCount, canAct }: { caseId: string; stored: Stored | null; trust: Trust | null; feedbackCount: number; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [auto, setAuto] = useState<Autonomous | null>(null);
  const [fb, setFb] = useState<Feedback | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "corrected" | "rejected">("accepted");
  const [category, setCategory] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [evidence, setEvidence] = useState("");
  const [, start] = useTransition();
  const a = stored?.assessment;

  async function call(url: string, body?: unknown) {
    setBusy(true); setErr("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (!res.ok) throw new Error(json.details?.[0]?.message ?? json.error);
      return json;
    } catch (e) { setErr((e as Error).message); return null; }
    finally { setBusy(false); }
  }
  async function run(mode: "auto" | "deterministic" = "auto") {
    const r = await call(`/api/cases/${caseId}/agent`, { mode });
    if (r) { setAuto(r.autonomous); setFb(null); start(() => router.refresh()); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await call(`/api/cases/${caseId}/agent/feedback`, { outcome, corrected_category: outcome === "corrected" ? category : undefined, reasoning, evidence: evidence.split(/[\s,]+/).filter(Boolean), assessment_id: stored?.id });
    if (r) { setFb(r); setReasoning(""); setEvidence(""); start(() => router.refresh()); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {canAct && <button type="button" onClick={() => run("auto")} disabled={busy} className={buttonClass("primary")}>{busy ? "Agents investigating… (up to a minute)" : a ? "Re-run multi-agent investigation" : "Run multi-agent investigation"}</button>}
        {canAct && <button type="button" onClick={() => run("deterministic")} disabled={busy} className={buttonClass("secondary")}>Run deterministic agent</button>}
        <span className="text-xs text-ink-3">Orchestrator → hypothesis → SQL → reviewer agents (OpenAI), then code verifies every cited ID against the database. Falls back to the deterministic tool agent without a key. Agents read data only and write their own assessment.</span>
      </div>
      {err && <p role="alert" className="text-sm text-risk-high">{err}</p>}
      {trust && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2">
          Earned trust for <span className="font-medium text-ink">{trust.category}</span>: <span className="font-semibold text-ink">{trust.trust.toFixed(3)}</span> from {trust.n} validated decision(s) · {trust.level_name}. {trust.next_step}. Trust is separate from this case&apos;s risk, confidence and exposure.
          {feedbackCount === 0 && " The agent has no earned trust yet, so a human approves every decision."}
        </p>
      )}
      {auto && (auto.performed.length > 0 || auto.blocked) && (
        <p role="status" className="rounded-md border border-line px-3 py-2 text-xs">{auto.performed.length ? `Autonomous internal actions performed (L${auto.level}): ${auto.performed.join(", ")}. No customer-impacting action was taken.` : `No autonomous action: ${auto.blocked}`}</p>
      )}
      {!a && <p className="text-sm text-ink-3">No assessment yet.</p>}
      {a && stored && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-3">Suspected category</div><div className="mt-1 text-lg font-semibold">{a.likely_benign ? "Likely legitimate" : a.predicted_category}</div><div className="text-xs text-ink-2">Evidence confidence {pct(a.confidence)}{a.likely_benign ? ` · closest fraud type: ${a.predicted_category}` : ""}</div></div>
            <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-3">Priority</div><div className="mt-1 text-lg font-semibold">{a.priority.tier}</div><div className="text-xs text-ink-2">{a.priority.reason}</div></div>
            <div className="rounded-lg border border-line p-3"><div className="text-xs text-ink-3">Claims verified against records</div><div className="mt-1 text-lg font-semibold">{a.verification.claims_verified}/{a.verification.claims_total}</div><div className="text-xs text-ink-2">{a.verification.dropped.length ? `${a.verification.dropped.length} dropped, not shown` : "none dropped"} · run {fmtTime(stored.created_at)} by {stored.created_by}</div></div>
          </div>

          {a.fallback_reason && <p className="rounded-md border border-risk-medium/60 bg-surface-2 px-3 py-2 text-xs">{a.fallback_reason}</p>}
          {a.mode === "llm-multi-agent" && a.agents && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Agent workflow · {a.model} · reviewer score {Math.round((a.reviewer_score ?? 0) * 100)}% · {a.agents.reduce((s, x) => s + x.tokens, 0)} tokens</h3>
              <ol className="flex flex-wrap items-center gap-2 text-xs">
                {a.agents.map((s, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <details className="rounded-md border border-line bg-surface px-2 py-1">
                      <summary className="cursor-pointer"><span className="font-medium capitalize">{s.agent}</span> <span className="text-ink-3">{(s.ms / 1000).toFixed(1)} s</span></summary>
                      <pre className="mt-2 max-h-64 max-w-[640px] overflow-auto whitespace-pre-wrap text-[11px] text-ink-2">{JSON.stringify(s.output, null, 2)}</pre>
                    </details>
                    {i < a.agents!.length - 1 && <span aria-hidden className="text-ink-3">→</span>}
                  </li>
                ))}
                <li className="flex items-center gap-2"><span aria-hidden className="text-ink-3">→</span><span className="rounded-md border border-accent/50 bg-accent-wash px-2 py-1 text-accent-ink">code verification: {a.verification.claims_verified}/{a.verification.claims_total} citations found</span></li>
              </ol>
              {a.lessons_used && a.lessons_used.length > 0 && <p className="text-xs text-ink-2">Applied {a.lessons_used.length} lesson(s) learned from earlier analyst corrections: <span className="italic">{a.lessons_used.slice(0, 2).join(" · ")}</span></p>}
              {a.sql && a.sql.length > 0 && (
                <details className="rounded-lg border border-line">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium">SQL written by the SQL agent ({a.sql.length} queries, read-only, source tables only)</summary>
                  <ul className="divide-y divide-line">
                    {a.sql.map((q, i) => (
                      <li key={i} className="px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2"><Pill tone={q.ok ? "good" : "bad"}>{q.ok ? `${q.row_count} rows` : "rejected"}</Pill>{q.repaired && <Pill tone="accent">self-repaired</Pill>}<span className="text-ink-2">H{q.hypothesis + 1}: {q.purpose}</span></div>
                        <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-[11px]">{q.sql}</pre>
                        {q.error && <p className="text-risk-high">{q.error}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {a.verification.dropped.length > 0 && <p className="text-xs text-risk-high">Removed by verification: {a.verification.dropped.slice(0, 3).join("; ")}</p>}
            </div>
          )}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Hypotheses · {a.mode === "llm-multi-agent" ? "reviewer confidence" : "share of evidence"}</h3>
            <ul className="space-y-2">
              {a.hypotheses.map((h) => (
                <li key={h.category} className="rounded-lg border border-line">
                  <details open={h === a.hypotheses[0]}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2 text-sm">
                      <span className="font-medium">{h.category}</span>
                      <span className="h-1.5 w-32 overflow-hidden rounded bg-surface-2"><span className="block h-full bg-accent" style={{ width: pct(h.confidence) }} /></span>
                      <span className="text-xs text-ink-2">{pct(h.confidence)} · {h.supports.length} supporting, {h.contradicts.length} contradicting</span>
                    </summary>
                    <div className="space-y-2 px-3 pb-3 text-sm">
                      <ul className="space-y-1">{h.supports.slice(0, 8).map((c, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-good-ink">＋</span><span>{c.text}<Cites claim={c} caseId={caseId} /></span></li>)}</ul>
                      {h.contradicts.length > 0 && <ul className="space-y-1">{h.contradicts.map((c, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-risk-high">－</span><span>{c.text}<Cites claim={c} caseId={caseId} /></span></li>)}</ul>}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Recommended next actions (a human decides)</h3>
              <ul className="space-y-2 text-sm">
                {a.recommended_actions.map((r) => (
                  <li key={r.action} className="rounded-lg border border-line px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.label}</span>{r.customer_impacting ? <Pill tone="warn">customer-impacting · recommendation only</Pill> : <Pill>internal</Pill>}</div>
                    <p className="text-xs text-ink-2">{r.rationale}</p>
                  </li>
                ))}
              </ul>
              {a.missing_information.length > 0 && (
                <div className="mt-3">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Missing information</h3>
                  <ul className="space-y-1 text-xs text-ink-2">{a.missing_information.slice(0, 6).map((m, i) => <li key={i}>• {m.item}: {m.why}</li>)}</ul>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Tool calls ({a.tool_calls.length})</h3>
              <ol className="space-y-1.5 text-xs">
                {a.tool_calls.map((t, i) => (
                  <li key={i} className="rounded border border-line px-2 py-1.5">
                    <span className={cx("font-mono font-medium", !t.ok && "text-risk-high")}>{i + 1}. {t.tool}</span>
                    <span className="text-ink-3"> · {t.purpose}</span>
                    <div className="text-ink-2">{t.summary}</div>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {canAct && (
            <form onSubmit={submit} className="space-y-3 rounded-lg border border-line bg-surface-2/50 p-3">
              <h3 className="text-sm font-semibold">Your review of this recommendation</h3>
              <div className="flex flex-wrap gap-2">
                {([["accepted", "Accept"], ["corrected", "Correct the category"], ["rejected", "Reject (not fraud / wrong)"]] as const).map(([v, l]) => (
                  <label key={v} className={cx("cursor-pointer rounded-md border px-3 py-1.5 text-sm", outcome === v ? "border-accent bg-accent-wash" : "border-line hover:bg-surface")}>
                    <input type="radio" name="outcome" value={v} checked={outcome === v} onChange={() => setOutcome(v)} className="mr-2 accent-[var(--accent)]" />{l}
                  </label>
                ))}
              </div>
              {outcome === "corrected" && (
                <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Correct category</span>
                  <select value={category} onChange={(e) => setCategory(e.target.value)} required className={inputClass}><option value="">Choose…</option>{AGENT_CATEGORIES.filter((c) => c !== a.predicted_category).map((c) => <option key={c}>{c}</option>)}</select></label>
              )}
              {outcome !== "accepted" && (
                <>
                  <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Reasoning (required)</span><textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={2} required minLength={5} className={inputClass} /></label>
                  <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Supporting evidence IDs, e.g. transactions:TXN123 (optional, checked against records)</span><input value={evidence} onChange={(e) => setEvidence(e.target.value)} className={inputClass} /></label>
                </>
              )}
              <button type="submit" disabled={busy} className={buttonClass("primary")}>Submit review</button>
              {fb && (
                <div role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
                  <div className="font-medium">{fb.category}: trust {fb.before.trust.toFixed(3)} → {fb.after.trust.toFixed(3)} <span className={fb.after.trust >= fb.before.trust ? "text-good-ink" : "text-risk-high"}>({fb.after.trust >= fb.before.trust ? "+" : ""}{(fb.after.trust - fb.before.trust).toFixed(3)})</span></div>
                  {fb.lesson && <div className="mt-1 text-xs"><span className="font-medium">Lesson learned:</span> {fb.lesson}</div>}
                  <div className="text-xs text-ink-2">{fb.loop}{fb.split === "holdout" ? " (held-out case: counted for validation only, trust unchanged)" : ""}</div>
                </div>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}
