"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";

type Summary = { total_alerts: number; new_alerts: number; total_cases: number; new_cases: number; ms: number; by_level: Record<string, number> };

export function RunDetectionButton({ disabled, variant = "primary" }: { disabled?: boolean; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/detect", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Detection failed");
      setResult(body);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={run} disabled={disabled || busy || pending} className={buttonClass(variant)}>
        {busy ? "Running detection…" : "Run detection"}
      </button>
      <span role="status" className="text-sm text-ink-2">
        {error && <span className="text-risk-high">{error}</span>}
        {result && !error && (
          <>
            {result.total_alerts} findings ({result.by_level.High} High, {result.by_level.Medium} Medium) · {result.new_alerts} new alerts · {result.new_cases} new cases · {result.ms} ms
          </>
        )}
      </span>
    </div>
  );
}
