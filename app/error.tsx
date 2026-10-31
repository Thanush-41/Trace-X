"use client";

import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-lg border border-risk-high/40 bg-surface px-6 py-10 text-center">
      <div className="font-medium">Something went wrong loading this page.</div>
      <p className="mt-1 text-sm text-ink-2">The error has been logged on the server. Try again, or go back to the dashboard.</p>
      <div className="mt-4 flex justify-center gap-2">
        <button type="button" onClick={reset} className={buttonClass("primary")}>Try again</button>
        <Link href="/" className={buttonClass()}>Dashboard</Link>
      </div>
    </div>
  );
}
