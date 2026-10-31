import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";

const body = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200) });

export const POST = handle(async (req: Request) => {
  const { username, password } = body.parse(await req.json().catch(() => ({})));
  const user = authenticate(username, password);
  if (!user) throw new HttpError(401, "Wrong username or password");
  const res = NextResponse.json({ username: user.username, name: user.name, role: user.role });
  res.cookies.set(SESSION_COOKIE, await signSession({ username: user.username, name: user.name, role: user.role }), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS,
  });
  return res;
});
