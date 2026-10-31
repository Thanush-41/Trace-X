"use client";

import Link from "next/link";
import { useState } from "react";
import type { ItemResult } from "@/lib/detect/evaluate";
import { LevelBadge, Stat, buttonClass, cx, inputClass } from "@/components/ui";

type Result = {
  run_id: string; policy_version: string; ms: number; seed: number | null;
  items: ItemResult[]; fraud_detected: number; fraud_total: number; recall: number;
  lookalikes_clean: number; lookalikes_total: number; lookalike_false_positive_rate: number;
  actionable_alerts: number; actionable_alerts_on_planted: number; precision: number;
};

export function EvaluationClient({ seeds }: { seeds: number[] }) {
  const [seed, setSeed] = useState(String(seeds[0] ?? 1));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details?.[0]?.message ?? data.error ?? "Evaluation failed");
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      await run(JSON.parse(await file.text()));
    } catch {
      setError("That file is not valid JSON.");
    }
  }

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const fraudDevice = result?.items.find((i) => i.kind === "fraud" && i.detector === "FD-02");
  const familyDevice = result?.items.find((i) => i.kind === "lookalike" && i.detector === "FD-02");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-ink-2">Answer key</span>
          <select value={seed} onChange={(e) => setSeed(e.target.value)} className={cx(inputClass, "w-48")}>
            {seeds.map((s) => <option key={s} value={s}>Bundled seed {s}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => run({ seed: Number(seed) })} disabled={busy} className={buttonClass("primary")}>{busy ? "Evaluating…" : "Evaluate latest run"}</button>
        <label className={cx(buttonClass(), "cursor-pointer")}>
          Upload ground_truth.json
          <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <p className="w-full text-xs text-ink-3">Pick the seed you loaded. The answer key is only read here, after detection has run; detectors never see it.</p>
      </div>

      {error && <p role="alert" className="rounded-md border border-risk-high/40 bg-surface px-3 py-2 text-sm text-risk-high">{error}</p>}

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Planted fraud detected" value={`${result.fraud_detected}/${result.fraud_total}`} hint={`recall ${pct(result.recall)}`} tone={result.recall === 1 ? "good" : "high"} />
            <Stat label="Lookalikes kept low" value={`${result.lookalikes_clean}/${result.lookalikes_total}`} hint={`false-positive rate ${pct(result.lookalike_false_positive_rate)}`} tone={result.lookalike_false_positive_rate === 0 ? "good" : "high"} />
            <Stat label="Actionable alerts on planted entities" value={`${result.actionable_alerts_on_planted}/${result.actionable_alerts}`} hint={`precision ${pct(result.precision)} (rest is background noise)`} />
            <Stat label="Detection time" value={`${result.ms} ms`} hint={`run ${result.run_id} · policy v${result.policy_version}`} />
          </div>
          {fraudDevice && familyDevice && (
            <section aria-labelledby="comparison-title" className="space-y-3">
              <div>
                <h2 id="comparison-title" className="text-base font-semibold">Same pattern, different conclusion</h2>
                <p className="text-sm text-ink-2">Both scenarios share a device. Corroborating money and identity links raise the fraud case; household and long-standing-use context reduce the legitimate one.</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <ComparisonCard title="Coordinated loan ring" item={fraudDevice} tone="risk" />
                <ComparisonCard title="Legitimate family device" item={familyDevice} tone="good" />
              </div>
            </section>
          )}
          {result.seed !== null && <p className="text-xs text-ink-3">Answer key for seed {result.seed}. If you loaded a different seed, scenarios will not match.</p>}
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>{["Result", "Scenario", "Kind", "Detector", "Expected", "Matched alerts"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td className={cx("px-4 py-2.5 font-semibold", i.pass ? "text-good-ink" : "text-risk-high")}>{i.pass ? "✓ Pass" : "✗ Fail"}</td>
                    <td className="px-4 py-2.5"><span className="font-medium">{i.scenario}</span> <span className="font-mono text-[11px] text-ink-3">{i.id}</span>{i.note && <div className="text-xs text-ink-2">{i.note}</div>}</td>
                    <td className="px-4 py-2.5 text-xs">{i.kind === "fraud" ? "Fraud" : "Legitimate lookalike"}</td>
                    <td className="px-4 py-2.5 text-xs">{i.detector}</td>
                    <td className="px-4 py-2.5 text-xs">{i.expectation}</td>
                    <td className="px-4 py-2.5">
                      {i.matched.length === 0 ? <span className="text-xs text-ink-3">no alert</span> : (
                        <ul className="space-y-1">
                          {i.matched.slice(0, 3).map((m) => (
                            <li key={m.alert_id}><Link href={`/alerts/${m.alert_id}`} className="inline-flex items-center gap-2 text-xs hover:underline"><LevelBadge level={m.level} score={m.score} />{m.title}</Link></li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ComparisonCard({ title, item, tone }: { title: string; item: ItemResult; tone: "risk" | "good" }) {
  const match = item.matched[0];
  return (
    <article className={cx("rounded-lg border bg-surface p-4", tone === "risk" ? "border-risk-high/40" : "border-good-ink/40")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        {match ? <LevelBadge level={match.level} score={match.score} /> : <span className="text-xs text-ink-3">No alert</span>}
      </div>
      <p className="mt-1 text-xs text-ink-2">{item.note}</p>
      {match && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Risk signals</div>
            <ul className="mt-1 space-y-1 text-xs">
              {match.signals.map((s) => <li key={s.label} className="flex justify-between gap-2"><span>{s.label}</span><span className="font-semibold text-risk-high">+{s.weight}</span></li>)}
            </ul>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Legitimate context</div>
            {match.mitigations.length ? (
              <ul className="mt-1 space-y-1 text-xs">
                {match.mitigations.map((m) => <li key={m.label} className="flex justify-between gap-2"><span>{m.label}</span><span className="font-semibold text-good-ink">−{m.weight}</span></li>)}
              </ul>
            ) : <p className="mt-1 text-xs text-ink-3">None found</p>}
          </div>
        </div>
      )}
    </article>
  );
}
