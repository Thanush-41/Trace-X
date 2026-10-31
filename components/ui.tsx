import Link from "next/link";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import type { Level } from "@/lib/policy";

export const cx = clsx;

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-accent-ink">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight md:text-[30px]">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("min-w-0 rounded-xl border border-line bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone, href, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "high" | "good"; href?: string; icon?: ReactNode }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-ink-3">
        <span>{label}</span>
        {icon && <span aria-hidden className="text-ink-3">{icon}</span>}
      </div>
      <div className={cx("mt-1.5 text-[28px] font-semibold leading-none tabular", tone === "high" && "text-risk-high", tone === "good" && "text-good-ink")}>{value}</div>
      {hint && <div className="mt-1.5 text-xs text-ink-2">{hint}</div>}
    </>
  );
  const cls = "block rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card";
  return href ? <Link href={href} className={cx(cls, "transition-colors hover:border-accent/60 hover:bg-accent-wash/30")}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** Removable chips for the filters currently applied to a list. */
export function FilterChips({ chips, clearHref }: { chips: { label: string; href: string }[]; clearHref: string }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-ink-3">Filters:</span>
      {chips.map((c) => (
        <Link key={c.label} href={c.href} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-ink-2 hover:border-risk-high/50 hover:text-ink" aria-label={`Remove filter ${c.label}`}>
          {c.label}<span aria-hidden className="text-ink-3">×</span>
        </Link>
      ))}
      <Link href={clearHref} className="ml-1 text-accent-ink hover:underline">Clear all</Link>
    </div>
  );
}

const LEVEL_STYLE: Record<Level, string> = {
  High: "bg-risk-high text-white",
  Medium: "bg-risk-medium text-black",
  Low: "bg-surface-2 text-ink-2 ring-1 ring-inset ring-line-strong",
};
const LEVEL_ICON: Record<Level, string> = { High: "▲", Medium: "◆", Low: "▽" };

/** Risk level always carries a symbol and a word, never colour alone. */
export function LevelBadge({ level, score }: { level: Level; score?: number }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold", LEVEL_STYLE[level])}>
      <span aria-hidden>{LEVEL_ICON[level]}</span>
      {level}
      {score !== undefined && <span className="tabular font-medium opacity-90">· {score}</span>}
    </span>
  );
}

export function Pill({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "accent" | "good" | "warn" | "bad"; title?: string }) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2",
    accent: "bg-accent-wash text-accent-ink",
    good: "bg-surface-2 text-good-ink",
    warn: "bg-surface-2 text-ink",
    bad: "bg-surface-2 text-risk-high",
  };
  return <span title={title} className={cx("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.8em]", className)}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function ButtonLink({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  return <Link href={href} className={buttonClass(variant)}>{children}</Link>;
}

export function buttonClass(variant: "primary" | "secondary" | "danger" = "secondary") {
  return cx(
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    variant === "primary" && "bg-accent text-white hover:bg-accent-ink",
    variant === "secondary" && "border border-line-strong bg-surface text-ink hover:bg-surface-2",
    variant === "danger" && "border border-risk-high/50 bg-surface text-risk-high hover:bg-surface-2",
  );
}

export const inputClass = "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

/** Horizontal bar list with direct value labels; one series, one hue. */
export function BarList({ rows, emptyText = "No data" }: { rows: { label: ReactNode; value: number; href?: string; title?: string }[]; emptyText?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-ink-3">{emptyText}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => {
        const inner = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-ink-2">{r.label}</span>
              <span className="tabular font-medium">{r.value}</span>
            </div>
            <div className="h-2 rounded-full bg-surface-2">
              <div className="h-2 rounded-r-[4px] bg-bar" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value > 0 ? 4 : 0 }} />
            </div>
          </>
        );
        return (
          <li key={i} title={r.title ?? `${r.value}`}>
            {r.href ? <Link href={r.href} className="block rounded hover:bg-surface-2/60">{inner}</Link> : inner}
          </li>
        );
      })}
    </ul>
  );
}

export const fmtTime = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "—");
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const fmtAmount = (n: unknown) => (n === null || n === undefined || n === "" ? "—" : `₹${inr.format(Number(n))}`);
export const fmtInt = (n: number) => new Intl.NumberFormat("en-IN").format(n);
