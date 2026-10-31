/** Minimal PDF writer (Helvetica, A4, wrapped text, page numbers). Enough for a readable case report without a dependency. */
const esc = (s: string) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, (c) => ({ "₹": "Rs ", "→": "->", "–": "-", "—": "-", "×": "x", "·": "|", "−": "-", "≥": ">=", "≤": "<=" } as Record<string, string>)[c] ?? "?");
export type PdfLine = { text: string; size?: number; bold?: boolean; gap?: number };

export function renderPdf(title: string, lines: PdfLine[]): Buffer {
  const W = 595, H = 842, M = 48;
  const pages: string[][] = [[]];
  let y = H - M;
  const wrap = (text: string, size: number) => {
    const max = Math.floor((W - 2 * M) / (size * 0.5));
    const out: string[] = [];
    for (const para of esc(text).split("\n")) {
      let cur = "";
      for (const w of para.split(" ")) {
        if ((cur + " " + w).trim().length > max) { out.push(cur); cur = w.length > max ? w.slice(0, max) : w; } else cur = (cur + " " + w).trim();
      }
      out.push(cur);
    }
    return out;
  };
  for (const l of lines) {
    const size = l.size ?? 9;
    y -= l.gap ?? 0;
    for (const t of wrap(l.text, size)) {
      if (y < M + 20) { pages.push([]); y = H - M; }
      pages[pages.length - 1].push(`BT /${l.bold ? "F2" : "F1"} ${size} Tf ${M} ${y} Td (${t}) Tj ET`);
      y -= size + 3;
    }
  }
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids: number[] = [];
  pages.forEach((p, i) => {
    p.push(`BT /F1 8 Tf ${M} 24 Td (${esc(title)}  -  page ${i + 1} of ${pages.length}) Tj ET`);
    const content = p.join("\n");
    const c = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`));
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
