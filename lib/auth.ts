import { cookies } from "next/headers";
import { HttpError } from "@/lib/api";
import { SESSION_COOKIE, verifySession, type Role, type Session } from "@/lib/session";

type User = { username: string; password: string; name: string; role: Role };

/**
 * Accounts come from TRACEX_USERS (JSON array of {username, password, name, role}).
 * Without it, two demo accounts exist so evaluators can sign in; they are listed on the login page.
 */
export const DEMO_USERS: User[] = [
  { username: "analyst", password: "analyst123", name: "Fraud Analyst", role: "analyst" },
  { username: "admin", password: "admin123", name: "Fraud Lead (admin)", role: "admin" },
];

export function users(): User[] {
  const raw = process.env.TRACEX_USERS;
  if (!raw) return DEMO_USERS;
  try {
    return JSON.parse(raw) as User[];
  } catch {
    console.error("TRACEX_USERS is not valid JSON; falling back to demo accounts");
    return DEMO_USERS;
  }
}

export const usingDemoUsers = () => !process.env.TRACEX_USERS;

export function authenticate(username: string, password: string): User | null {
  return users().find((u) => u.username === username && u.password === password) ?? null;
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
