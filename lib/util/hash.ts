import { createHash, randomUUID } from "node:crypto";

/** JSON with sorted keys, so equal objects always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Short readable ID, e.g. newId("ALT") → "ALT-3f9c1a2b". */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Deterministic readable ID derived from content, e.g. "ALT-3f9c1a2b4d". */
export function idFrom(prefix: string, content: string): string {
  return `${prefix}-${sha256(content).slice(0, 10)}`;
}
