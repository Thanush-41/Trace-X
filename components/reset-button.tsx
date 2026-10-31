"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass } from "@/components/ui";

export function ResetButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function reset() {
    if (!window.confirm("Delete all imported data, alerts, cases and decisions? This cannot be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "RESET" }) });
      if (!res.ok) throw new Error("Reset failed");
      router.refresh();
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" onClick={reset} disabled={busy} className={buttonClass("danger")}>
      {busy ? "Resetting…" : "Reset workspace"}
    </button>
  );
}
