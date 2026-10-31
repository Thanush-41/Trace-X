"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonClass, cx, inputClass } from "@/components/ui";

const OPTIONS = [
  ["REQUIRES_INVESTIGATION", "Requires investigation", "Assign for a full investigation"],
  ["ESCALATED", "Escalate", "Refer to the fraud/compliance lead"],
  ["FALSE_POSITIVE", "False positive", "Legitimate activity; note why"],
  ["DISMISSED", "Dismiss", "No action needed; note why"],
] as const;
const CATEGORIES = ["Suspicious transfer", "Coordinated device use", "Account takeover", "Loan application fraud", "Insurance claim fraud", "Cross-system organised fraud", "Identity fraud", "Mule activity"];

export function DecisionForm({ caseId, level, category }: { caseId: string; level: string; category: string }) {
  const router = useRouter();
  const [decision, setDecision] = useState<string>("REQUIRES_INVESTIGATION");
  const [note, setNote] = useState("");
  const [revisedLevel, setRevisedLevel] = useState("");
  const [revisedCategory, setRevisedCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const noteRequired = decision === "FALSE_POSITIVE" || decision === "DISMISSED";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note, revised_level: revisedLevel || null, revised_category: revisedCategory || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.[0]?.message ?? body.error ?? "Could not save the decision");
      setMessage({ ok: true, text: "Decision recorded. The original alerts are unchanged." });
      setNote("");
      setRevisedLevel("");
      setRevisedCategory("");
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-ink-2">Decision</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map(([value, label, hint]) => (
            <label key={value} className={cx("flex cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm", decision === value ? "border-accent bg-accent-wash" : "border-line hover:bg-surface-2")}>
              <input type="radio" name="decision" value={value} checked={decision === value} onChange={() => setDecision(value)} className="mt-0.5 accent-[var(--accent)]" />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-xs text-ink-2">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-2">Note {noteRequired ? "(required)" : "(optional)"}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} required={noteRequired} minLength={noteRequired ? 5 : undefined}
          placeholder={noteRequired ? "Why is this legitimate or not actionable?" : "Findings, next steps…"} className={inputClass} />
      </label>
      <p className="text-xs text-ink-3">This decision will be attributed to your signed-in account.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-2">Reclassify risk (optional)</span>
          <select value={revisedLevel} onChange={(e) => setRevisedLevel(e.target.value)} className={inputClass}>
            <option value="">Keep {level}</option>
            {["High", "Medium", "Low"].filter((l) => l !== level).map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-2">Reclassify category (optional)</span>
          <select value={revisedCategory} onChange={(e) => setRevisedCategory(e.target.value)} className={inputClass}>
            <option value="">Keep {category}</option>
            {CATEGORIES.filter((c) => c !== category).map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={buttonClass("primary")}>{busy ? "Saving…" : "Record decision"}</button>
        {message && <span role="status" className={cx("text-sm", message.ok ? "text-good-ink" : "text-risk-high")}>{message.text}</span>}
      </div>
    </form>
  );
}
