import { cookies } from "next/headers";
import { HttpError } from "@/lib/api";
import { SESSION_COOKIE, verifySession, type Role, type Session } from "@/lib/session";

import { scryptSync, timingSafeEqual } from "node:crypto";

/** `password` is either plain text (only for local TRACEX_USERS overrides) or "scrypt:<salt hex>:<hash hex>". */
type User = { username: string; password: string; name: string; role: Role };

/**
 * Built-in accounts (passwords stored only as scrypt hashes). TRACEX_USERS, a JSON array of
 * {username, password, name, role}, replaces them entirely for another deployment.
 */
export const DEFAULT_USERS: User[] = [
  {
    username: "thanushgarimella@gmail.com",
    password: "scrypt:ee5bb4f94a88058ed11bd6cac2cb1783:4c66a94002c366ec185ceb074ad3b9ffee8352fc858c85a4457ccbfbcde813c2",
    name: "Thanush Garimella",
    role: "admin",
  },
  {
    username: "test@agentio.com",
    password: "scrypt:959c350e0e0bd57881bfd07fecb5e63a:ee6b962d2d2585e75b6aeb426ad032784c1b0a498db2dfe48d44fbabb534a8e7",
    name: "Test Investigator",
    role: "analyst",
  },
];

export function users(): User[] {
  const raw = process.env.TRACEX_USERS;
  if (!raw) return DEFAULT_USERS;
  try {
    return JSON.parse(raw) as User[];
  } catch {
    console.error("TRACEX_USERS is not valid JSON; falling back to the built-in accounts");
    return DEFAULT_USERS;
  }
}

function passwordMatches(stored: string, given: string): boolean {
  if (stored.startsWith("scrypt:")) {
    const [, salt, hash] = stored.split(":");
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(given, salt, expected.length);
    return timingSafeEqual(expected, actual);
  }
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Usernames are matched case-insensitively (they are email addresses). */
export function authenticate(username: string, password: string): User | null {
  const user = users().find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
  return user && passwordMatches(user.password, password) ? user : null;
}

export async function currentSession(): Promise<Session | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Server-side guard for route handlers: 401 when signed out, 403 when the role is not allowed. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in required");
  if (roles.length && !roles.includes(s.role)) throw new HttpError(403, `This action needs the ${roles.join(" or ")} role`);
  return s;
}
