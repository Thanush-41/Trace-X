"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Bell, BriefcaseBusiness, Bot, FlaskConical, LayoutDashboard, Menu, Network, ScrollText, Upload, Users, X } from "lucide-react";

export const NAV = [
  { href: "/", label: "Command center", icon: LayoutDashboard },
  { href: "/ingest", label: "Data ingestion", icon: Upload },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/cases", label: "Cases", icon: BriefcaseBusiness },
  { href: "/graph", label: "Relationship graph", icon: Network },
  { href: "/agent", label: "Agent trust", icon: Bot },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/rules", label: "Detection rules", icon: ScrollText },
  { href: "/evaluation", label: "Evaluation", icon: FlaskConical },
];

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight text-nav-strong">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm text-white shadow-sm">X</span>
      <span>
        TRACE X
        <span className="block text-[11px] font-normal tracking-normal text-nav-ink">Fraud intelligence</span>
      </span>
    </Link>
  );
}

function Links({ active, onNavigate }: { active: (href: string) => boolean; onNavigate?: () => void }) {
  return (
    <>
      {NAV.map(({ href, label, icon: Icon }) => {
        const on = active(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={on ? "page" : undefined}
            className={clsx(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              on ? "bg-nav-active font-medium text-nav-strong" : "text-nav-ink hover:bg-nav-hover hover:text-nav-strong",
            )}
          >
            <Icon aria-hidden className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </>
  );
}

const isActive = (path: string) => (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

export function SidebarNav() {
  return <Links active={isActive(usePathname())} />;
}

export function StaticSidebarNav() {
  return <Links active={() => false} />;
}

export function MobileNav({ footer }: { footer?: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} className="rounded-md p-1.5 text-nav-strong hover:bg-nav-hover">
        <Menu className="h-5 w-5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-nav text-nav-ink shadow-xl">
            <div className="flex items-center justify-between px-5 pb-4 pt-5">
              <Brand />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded-md p-1.5 text-nav-strong hover:bg-nav-hover"><X className="h-5 w-5" /></button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main"><Links active={isActive(path)} onNavigate={() => setOpen(false)} /></nav>
            <div className="space-y-3 border-t border-nav-line px-4 py-4">{footer}</div>
          </div>
        </div>
      )}
    </>
  );
}
