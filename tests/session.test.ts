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
    // Always change the last character (replacing it with a fixed letter is a no-op 1 time in 64).
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    expect(await verifySession(`${flip(payload)}.${signature}`)).toBeNull();
    expect(await verifySession(`${payload}.${flip(signature)}`)).toBeNull();
  });

  it("rejects missing and malformed tokens", async () => {
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("not-a-session")).toBeNull();
    expect(await verifySession("bad.payload.parts")).toBeNull();
  });
});
