import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { DATASET_TYPES } from "@/lib/ingest/fields";
import { ingestFile } from "@/lib/ingest/load";
import { logEvent } from "@/lib/db/client";

// Matches the hosting request limit (Vercel rejects larger bodies before the route runs).
const MAX_BYTES = 4.5 * 1024 * 1024;
const typeSchema = z.enum(DATASET_TYPES).optional();

export const POST = handle(async (req: Request) => {
  const session = await requireRole("analyst", "admin");
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "Expected multipart/form-data with one or more 'file' fields");
  });
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new HttpError(400, "No file uploaded");
  const typeValue = form.get("type");
  const override = typeSchema.parse(typeValue && typeValue !== "auto" ? typeValue : undefined);

  const results = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      results.push({ ok: false as const, filename: file.name, error: "File is larger than 4.5 MB; split it or use the bundled dataset loader" });
      continue;
    }
    results.push(...(await ingestFile(Buffer.from(await file.arrayBuffer()), file.name, override)));
  }
  const accepted = results.reduce((s, r) => s + (r.ok ? r.accepted : 0), 0);
  await logEvent("upload", `Uploaded ${files.map((f) => f.name).join(", ")}: ${accepted} new records`, `${session.name} (${session.username})`);
  return NextResponse.json({ results });
});
