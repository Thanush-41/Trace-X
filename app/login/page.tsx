import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { DEMO_USERS, usingDemoUsers } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  const demo = usingDemoUsers();
  return (
    <div className="mx-auto mt-10 max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">TRACE X is for authorised fraud investigators.</p>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      {demo && (
        <div className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm">
          <div className="font-medium">Demo accounts</div>
          <ul className="mt-2 space-y-1 text-ink-2">
            {DEMO_USERS.map((u) => (
              <li key={u.username}><span className="font-mono text-ink">{u.username}</span> / <span className="font-mono text-ink">{u.password}</span>: {u.role === "admin" ? "everything, including workspace reset" : "import, detect, investigate, decide"}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-3">Set TRACEX_USERS and TRACEX_SESSION_SECRET to replace these in a real deployment.</p>
        </div>
      )}
    </div>
  );
}
