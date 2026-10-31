"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Sign-in failed");
      return;
    }
    const next = params.get("next");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-2">Email</span>
        <input name="username" type="email" required autoComplete="username" placeholder="you@company.com" className={inputClass} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-2">Password</span>
        <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
      </label>
      {error && <p role="alert" className="text-sm text-risk-high">{error}</p>}
      <button type="submit" disabled={busy} className={`${buttonClass("primary")} w-full`}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
