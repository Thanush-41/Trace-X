"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

export const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/ingest", label: "Data ingestion" },
  { href: "/alerts", label: "Alerts" },
  { href: "/cases", label: "Cases" },
  { href: "/rules", label: "Rules" },
  { href: "/evaluation", label: "Evaluation" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <>
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
              active ? "bg-accent-wash font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </>
  );
}

export function StaticNavLinks() {
  return (
    <>
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-ink-2">
          {n.label}
        </Link>
      ))}
    </>
  );
}
