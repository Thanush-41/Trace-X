import { createClient, type Client, type InArgs } from "@libsql/client";
import { MIGRATIONS, SCHEMA_SQL, TABLES } from "./schema";

let client: Client | undefined;
let ready: Promise<void> | undefined;

function dbUrl(): string {
  return process.env.TURSO_DATABASE_URL ?? process.env.TRACEX_DB_URL ?? "file:tracex.db";
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
export async function resetWorkspace(): Promise<void> {
  const db = await getDb();
  await db.batch(TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`), "write");
  ready = undefined;
  await getDb();
}
