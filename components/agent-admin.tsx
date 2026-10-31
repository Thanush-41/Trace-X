"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonClass, cx, inputClass } from "@/components/ui";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.details?.[0]?.message ?? json.error);
  return json;
}

/** Admin controls: global kill switch, stricter thresholds, and the labelled answer-key replay. */
export function AgentAdmin({ killSwitch, thresholds }: { killSwitch: boolean; thresholds: { L2: { minFeedback: number; minTrust: number }; L3: { minFeedback: number; minTrust: number; minHoldout: number; minHoldoutAccuracy: number } } }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeds, setSeeds] = useState("3");
  const [l3, setL3] = useState(String(thresholds.L3.minFeedback));
  const [hold, setHold] = useState(String(thresholds.L3.minHoldout));
  const [, start] = useTransition();
  async function run(fn: () => Promise<{ ok: string }>) {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: (await fn()).ok }); start(() => router.refresh()); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} className={buttonClass(killSwitch ? "secondary" : "danger")} onClick={() => run(async () => { await post("/api/agent/settings", { kill_switch: !killSwitch }); return { ok: killSwitch ? "Autonomy re-enabled (earned levels apply again)." : "Kill switch ON: the agent can take no autonomous action." }; })}>
          {killSwitch ? "Turn kill switch off" : "Engage kill switch"}
        </button>
        <span className="text-xs text-ink-2">{killSwitch ? "Autonomous actions are disabled everywhere." : "Autonomy is only possible in categories that have earned L3."}</span>
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post("/api/agent/settings", { thresholds: { L3: { minFeedback: Number(l3), minHoldout: Number(hold) } } }); return { ok: "Thresholds saved (they can only be set within the safe floors)." }; }); }}>
        <label className="block"><span className="mb-1 block text-xs text-ink-2">L3 min training decisions (≥5)</span><input value={l3} onChange={(e) => setL3(e.target.value)} inputMode="numeric" className={cx(inputClass, "w-28")} /></label>
        <label className="block"><span className="mb-1 block text-xs text-ink-2">L3 min held-out decisions (≥3)</span><input value={hold} onChange={(e) => setHold(e.target.value)} inputMode="numeric" className={cx(inputClass, "w-28")} /></label>
        <button type="submit" disabled={busy} className={buttonClass("secondary")}>Save thresholds</button>
        <span className="text-xs text-ink-3">Trust floors stay L2 {thresholds.L2.minTrust}, L3 {thresholds.L3.minTrust}; held-out accuracy ≥ {Math.round(thresholds.L3.minHoldoutAccuracy * 100)}%.</span>
      </form>
      <form className="flex flex-wrap items-end gap-3 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post("/api/agent/replay", { seeds: seeds.split(/[\s,+]+/).filter(Boolean).map(Number) }); return { ok: `Recorded simulated-analyst feedback on ${r.results.length} case(s). It is labelled as simulated everywhere.` }; }); }}>
        <label className="block"><span className="mb-1 block text-xs text-ink-2">Simulated analyst: answer-key seeds loaded in the workspace</span><input value={seeds} onChange={(e) => setSeeds(e.target.value)} className={cx(inputClass, "w-40")} placeholder="3 or 1,2,3" /></label>
        <button type="submit" disabled={busy} className={buttonClass("secondary")}>Replay answer key as feedback</button>
        <span className="text-xs text-ink-3">For evaluation and demos only. Each case is judged against the bundled answer key; real analyst decisions stay separate (toggle below).</span>
      </form>
      {msg && <p role="status" className={cx("text-sm", msg.ok ? "text-good-ink" : "text-risk-high")}>{msg.text}</p>}
    </div>
  );
}
