import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nav px-4">
    <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-xl">
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-semibold text-white">X</span>
        <span className="text-lg font-semibold tracking-tight">TRACE X</span>
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">For authorised fraud investigators. Use the email and password provided with the submission.</p>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
    </div>
  );
}
