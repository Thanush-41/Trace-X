import { createClient, type Client, type InArgs } from "@libsql/client";
import { MIGRATIONS, SCHEMA_SQL, TABLES } from "./schema";

let client: Client | undefined;
let ready: Promise<void> | undefined;

/**
 * One durable database for every request. A hosted deployment without TURSO_DATABASE_URL would silently give each
 * serverless instance its own throwaway SQLite file, so it fails fast instead.
 */
function dbUrl(): string {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  if (process.env.VERCEL) throw new Error("TURSO_DATABASE_URL must be set on hosted deployments; refusing to use a per-instance local file");
  return process.env.TRACEX_DB_URL ?? "file:tracex.db";
}

/** Shared client with the schema applied. Safe to call from every request. */
export async function getDb(): Promise<Client> {
  if (!client) {
    client = createClient({ url: dbUrl(), authToken: process.env.TURSO_AUTH_TOKEN });
  }
  if (!ready) {
    const c = client;
    ready = c.executeMultiple(SCHEMA_SQL).then(async () => {
      for (const sql of MIGRATIONS) await c.execute(sql).catch(() => undefined); // column already exists
    }).catch((err) => {
      ready = undefined;
      throw err;
    });
  }
  await ready;
  return client;
}

export async function all<T>(sql: string, args: InArgs = []): Promise<T[]> {
  const db = await getDb();
  const res = await db.execute({ sql, args });
  return res.rows as unknown as T[];
}

export async function one<T>(sql: string, args: InArgs = []): Promise<T | undefined> {
  return (await all<T>(sql, args))[0];
}

/** Drops every table and recreates the schema. The only path that removes alerts. */
export async function resetWorkspace(actor = "system"): Promise<void> {
  const db = await getDb();
  await db.batch(TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`), "write");
  ready = undefined;
  await getDb();
  await logEvent("reset", "Workspace reset: all imported data, alerts, cases and decisions were deleted", actor);
}

/** Workspace activity log. It is not dropped by reset, so everyone can see who changed the shared data and when. */
export async function logEvent(kind: string, detail: string, actor: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "INSERT INTO workspace_events (kind, detail, actor, created_at) VALUES (?,?,?,?)", args: [kind, detail, actor, new Date().toISOString()] });
}
