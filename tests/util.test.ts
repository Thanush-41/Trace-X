import { describe, expect, it } from "vitest";
import { normEmail, normPhone, normAddress, parseAmount, parseTimestamp, normOutcome, normProduct, surnameOf } from "@/lib/util/normalize";
import { median, mad, quantile, robustZ } from "@/lib/util/stats";
import { UnionFind } from "@/lib/util/unionfind";
import { hashObject } from "@/lib/util/hash";

describe("normalize", () => {
  it("phone compares on the last 10 digits", () => {
    expect(normPhone("+91 98765-43210")).toBe("9876543210");
    expect(normPhone("09876543210")).toBe("9876543210");
  });
  it("gmail aliases collapse to one inbox", () => {
    expect(normEmail("Ravi.Kumar+loans@GMail.com")).toBe("ravikumar@gmail.com");
    expect(normEmail("ravi.kumar@corp.in")).toBe("ravi.kumar@corp.in");
  });
  it("addresses normalise abbreviations", () => {
    expect(normAddress("12, MG Rd.")).toBe(normAddress("12 mg road"));
  });
  it("timestamps in supported formats", () => {
    expect(parseTimestamp("2026-10-01 09:30")).toBe("2026-10-01T09:30:00.000Z");
    expect(parseTimestamp("2026-10-01T09:30:00+05:30")).toBe("2026-10-01T04:00:00.000Z");
    expect(parseTimestamp("01/10/2026 09:30")).toBe("2026-10-01T09:30:00.000Z");
    expect(parseTimestamp(46296)).toBe("2026-10-01T00:00:00.000Z");
    expect(parseTimestamp("31/02/2026")).toBeNull();
    expect(parseTimestamp("yesterday")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
  it("amounts", () => {
    expect(parseAmount("₹1,20,000.50")).toBe(120000.5);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(-5)).toBe(-5);
  });
  it("enums", () => {
    expect(normOutcome("FAILED")).toBe("failure");
    expect(normOutcome("maybe")).toBeNull();
    expect(normProduct("Loan")).toBe("lending");
    expect(surnameOf("Asha  Rao")).toBe("rao");
  });
});

describe("stats", () => {
  it("median, MAD, quantile", () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(quantile([0, 10], 0.95)).toBeCloseTo(9.5);
  });
  it("robust z ignores one historic outlier", () => {
    const hist = [1000, 1100, 900, 1050, 950, 50000];
    expect(robustZ(1020, hist)).toBeLessThan(1);
    expect(robustZ(20000, hist)).toBeGreaterThan(3.5);
  });
});

describe("union-find and hashing", () => {
  it("groups connected items", () => {
    const uf = new UnionFind<string>();
    uf.union("a", "b"); uf.union("c", "d"); uf.union("b", "d"); uf.add("e");
    const groups = uf.groups().map((g) => g.sort().join(""));
    expect(groups.sort()).toEqual(["abcd", "e"]);
  });
  it("hash is key-order independent", () => {
    expect(hashObject({ a: 1, b: [2, 3] })).toBe(hashObject({ b: [2, 3], a: 1 }));
  });
});
