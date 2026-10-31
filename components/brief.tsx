import type { Brief } from "@/lib/narrative";
import { refAnchor } from "@/components/evidence";
import { Card } from "@/components/ui";

function Cites({ refs }: { refs: Brief["summary"][number]["cites"] }) {
  if (!refs.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {refs.map((r) => (
        <a key={`${r.table}:${r.id}`} href={`#${refAnchor(r)}`} className="rounded border border-line px-1 font-mono text-[10px] text-accent-ink hover:bg-surface-2">{r.id}</a>
      ))}
    </span>
  );
}

export function InvestigationBrief({ brief }: { brief: Brief }) {
  return (
    <Card title="Investigation brief">
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">What happened</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {brief.summary.map((l, i) => <li key={i}>{l.text}<Cites refs={l.cites} /></li>)}
          </ol>
        </div>
        <div className="lg:col-span-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Next checks</h3>
          <ul className="space-y-1.5 text-sm">
            {brief.nextChecks.map((l, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-accent-ink">☐</span><span>{l.text}<Cites refs={l.cites} /></span></li>)}
          </ul>
        </div>
      </div>
      <p className="mt-4 text-xs text-ink-3">{brief.method}</p>
    </Card>
  );
}
