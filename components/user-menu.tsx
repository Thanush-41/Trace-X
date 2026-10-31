import { connection } from "next/server";
import { currentSession } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export async function UserMenu() {
  await connection();
  const s = await currentSession();
  if (!s) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm">
      <span className="hidden text-ink-2 sm:inline">{s.name}</span>
      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">{s.role}</span>
      <LogoutButton />
    </div>
  );
}
