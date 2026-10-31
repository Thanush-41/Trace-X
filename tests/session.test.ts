import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "@/lib/session";

describe("signed sessions", () => {
  it("round-trips an authenticated role", async () => {
    const token = await signSession({ username: "analyst", name: "Fraud Analyst", role: "analyst" });
    const session = await verifySession(token);
    expect(session).toMatchObject({ username: "analyst", name: "Fraud Analyst", role: "analyst" });
    expect(session!.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("rejects a tampered payload or signature", async () => {
    const token = await signSession({ username: "admin", name: "Fraud Lead", role: "admin" });
    const [payload, signature] = token.split(".");
    expect(await verifySession(`${payload.slice(0, -1)}A.${signature}`)).toBeNull();
    expect(await verifySession(`${payload}.${signature.slice(0, -1)}A`)).toBeNull();
  });

  it("rejects missing and malformed tokens", async () => {
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("not-a-session")).toBeNull();
    expect(await verifySession("bad.payload.parts")).toBeNull();
  });
});
