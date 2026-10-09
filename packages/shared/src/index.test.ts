import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ReadingInput, chooseLane, compareReadings, normaliseEventTime } from "./index.js";

describe("normaliseEventTime", () => {
  it("accepts ISO strings, keeping sub-millisecond digits", () => {
    expect(normaliseEventTime("2026-10-09T12:00:00.123456Z")).toEqual({
      iso: "2026-10-09T12:00:00.123456Z",
      ms: Date.UTC(2026, 9, 9, 12, 0, 0, 123),
    });
  });
  it("treats a zoneless timestamp as UTC", () => {
    expect(normaliseEventTime("2026-10-09T12:00:00")?.ms).toBe(Date.UTC(2026, 9, 9, 12));
    expect(normaliseEventTime("2026-10-09 12:00:00")?.ms).toBe(Date.UTC(2026, 9, 9, 12));
  });
  it("honours explicit offsets", () => {
    expect(normaliseEventTime("2026-10-09T14:00:00+02:00")?.ms).toBe(Date.UTC(2026, 9, 9, 12));
  });
  it("accepts epoch seconds and milliseconds", () => {
    const ms = Date.UTC(2026, 9, 9, 12);
    expect(normaliseEventTime(ms / 1000)?.ms).toBe(ms);
    expect(normaliseEventTime(ms)?.ms).toBe(ms);
    expect(normaliseEventTime(String(ms / 1000))?.ms).toBe(ms);
    expect(normaliseEventTime(ms / 1000 + 0.5)?.ms).toBe(ms + 500);
  });
  it("rejects garbage", () => {
    for (const bad of ["yesterday", "", "2026-13-45T99:99:99Z", -5, null, {}]) expect(normaliseEventTime(bad)).toBeNull();
  });
});

describe("ReadingInput", () => {
  const base = { gateway_id: "gw-1", device_id: "d-1", metric: "temp", value: 21.5, event_time: "2026-10-09T12:00:00Z", sequence: 7 };
  it("accepts the wire contract", () => {
    expect(ReadingInput.parse(base)).toMatchObject({ ...base, event_time_ms: Date.UTC(2026, 9, 9, 12) });
  });
  it("accepts status strings and numeric-string sequences", () => {
    expect(ReadingInput.parse({ ...base, value: "running", sequence: "12" })).toMatchObject({ value: "running", sequence: 12 });
  });
  it("rejects negative or fractional sequences and empty ids", () => {
    expect(ReadingInput.safeParse({ ...base, sequence: -1 }).success).toBe(false);
    expect(ReadingInput.safeParse({ ...base, sequence: 1.5 }).success).toBe(false);
    expect(ReadingInput.safeParse({ ...base, device_id: "" }).success).toBe(false);
  });
});

describe("chooseLane", () => {
  it("sends readings older than 60s to the backlog lane", () => {
    expect(chooseLane(1_000_000, 1_000_000 + 60_000)).toBe("live");
    expect(chooseLane(1_000_000, 1_000_000 + 60_001)).toBe("backlog");
  });
});

describe("compareReadings", () => {
  const arb = fc.record({
    event_time_ms: fc.integer({ min: 0, max: 5 }),
    gateway_id: fc.constantFrom("gw-a", "gw-b", "GW-c"),
    sequence: fc.integer({ min: 0, max: 5 }),
  });
  it("is a total order (antisymmetric and transitive)", () => {
    fc.assert(
      fc.property(arb, arb, arb, (a, b, c) => {
        expect(Math.sign(compareReadings(a, b)) + Math.sign(compareReadings(b, a))).toBe(0);
        if (compareReadings(a, b) <= 0 && compareReadings(b, c) <= 0) expect(compareReadings(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });
});
