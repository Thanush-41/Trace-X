"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pill, buttonClass, cx, fmtTime, inputClass } from "@/components/ui";
import type { ActionView } from "@/lib/actions";

const ACTIONS = [
  ["REQUIRES_INVESTIGATION", "Requires investigation", false],
  ["FALSE_POSITIVE", "False positive (reason required)", false],
  ["REQUEST_INFORMATION", "Request information", false],
  ["ESCALATE_SPECIALIST", "Escalate to specialist", false],
  ["ESCALATE_SUPERVISOR", "Escalate to supervisor", false],
  ["RECOMMEND_HOLD", "Recommend temporary hold", true],
  ["RECOMMEND_ENHANCED_VERIFICATION", "Recommend enhanced verification", true],
  ["ADD_NOTE", "Add investigator note", false],
  ["SET_CONCLUSION", "Record investigation conclusion", false],
  ["CLOSE_CASE", "Close case", false],
] as const;

const STATUS_TONE: Record<string, "neutral" | "warn" | "good" | "bad"> = { recorded: "neutral", pending_approval: "warn", approved: "good", rejected: "bad" };
const STATUS_TEXT: Record<string, string> = { recorded: "Recorded", pending_approval: "Awaiting supervisor", approved: "Approved by supervisor", rejected: "Rejected by supervisor" };

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.details?.[0]?.message ?? json.error ?? "Request failed");
  return json;
}

/** Analyst workflow: actions with reasons, authorised approval of customer-impacting recommendations, immutable history. */
export function CaseActions({ caseId, actions, role, me }: { caseId: string; actions: ActionView[]; role: string; me: string }) {
  const router = useRouter();
  const [action, setAction] = useState<string>("REQUIRES_INVESTIGATION");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState("inconclusive");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const impacting = ACTIONS.find((a) => a[0] === action)?.[2];

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); setReason(""); start(() => router.refresh()); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/cases/${caseId}/actions`, { action, reason, outcome: action === "SET_CONCLUSION" ? outcome : undefined }), impacting ? "Recommendation recorded. It will not take effect until a supervisor approves it, and TRACE X never applies it to the customer." : "Action recorded."); }} className="grid gap-3 sm:grid-cols-[220px_1fr]">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-2">Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)} className={inputClass}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-2">Reason / note</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required minLength={5} placeholder="What you found or why you are taking this step" className={inputClass} />
        </label>
        {action === "SET_CONCLUSION" && (
          <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Outcome</span>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={inputClass}><option value="confirmed_fraud">Confirmed fraud</option><option value="not_fraud">Not fraud</option><option value="inconclusive">Inconclusive</option></select>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={busy} className={buttonClass("primary")}>{busy ? "Saving…" : "Record action"}</button>
          {impacting && <Pill tone="warn">Customer-impacting: stays a recommendation until a supervisor approves</Pill>}
          {msg && <span role="status" className={cx("text-sm", msg.ok ? "text-good-ink" : "text-risk-high")}>{msg.text}</span>}
        </div>
      </form>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Action history ({actions.length}) · append-only</h3>
        {actions.length === 0 ? <p className="text-sm text-ink-3">No actions yet.</p> : (
          <ol className="divide-y divide-line rounded-lg border border-line">
            {actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="w-32 shrink-0 text-xs text-ink-3 tabular">{fmtTime(a.created_at)} UTC</span>
                <span className="w-52 shrink-0 font-medium">{a.label}</span>
                <span className="w-44 shrink-0"><Pill tone={STATUS_TONE[a.effective_status] ?? "neutral"}>{STATUS_TEXT[a.effective_status] ?? a.effective_status}</Pill></span>
                <span className="min-w-0 flex-1 text-ink-2">
                  <span className="font-medium text-ink">{a.actor}</span>{a.reason ? `: ${a.reason}` : ""}
                  {a.approval && <span className="block text-xs text-ink-3">{a.approval.status} by {a.approval.actor} on {fmtTime(a.approval.created_at)}: {a.approval.reason}</span>}
                  {a.customer_impacting && a.effective_status === "approved" && <span className="block text-xs text-ink-3">Approval is a record for the operations team. TRACE X does not place holds or change accounts.</span>}
                </span>
                {a.customer_impacting && a.effective_status === "pending_approval" && (
                  role === "admin" && a.actor !== me ? (
                    <ApprovalButtons caseId={caseId} id={a.id} onDone={() => start(() => router.refresh())} />
                  ) : <span className="text-xs text-ink-3">{role === "admin" ? "You raised this; another supervisor must decide" : "Needs a supervisor (admin) to approve"}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function ApprovalButtons({ caseId, id, onDone }: { caseId: string; id: number; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  async function decide(outcome: "approved" | "rejected") {
    setErr("");
    try { await post(`/api/cases/${caseId}/actions/${id}/approval`, { outcome, reason }); onDone(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Approval reason" className={cx(inputClass, "w-40")} />
      <button type="button" className={buttonClass("primary")} onClick={() => decide("approved")}>Approve</button>
      <button type="button" className={buttonClass("secondary")} onClick={() => decide("rejected")}>Reject</button>
      {err && <span className="text-xs text-risk-high">{err}</span>}
    </span>
  );
}
