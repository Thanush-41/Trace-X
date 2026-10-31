import { connection } from "next/server";
import { currentSession } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export async function UserMenu({ variant = "sidebar" }: { variant?: "sidebar" }) {
  await connection();
  const s = await currentSession();
  if (!s) return null;
  return (
    <div className="flex items-center gap-2.5" data-variant={variant}>
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-nav-active text-xs font-semibold text-nav-strong">
        {s.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
      </span>
      <div className="min-w-0 flex-1 text-xs">
        <div className="truncate font-medium text-nav-strong">{s.name}</div>
        <div className="truncate text-nav-ink">{s.username} · {s.role}</div>
      </div>
      <LogoutButton />
    </div>
  );
}
