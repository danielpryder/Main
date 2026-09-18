import { describe, expect, it } from "vitest";
import { addDays, daysBetween, localDateTime, normalizeClock, toJsDateString, toUnpaddedDate, todayIn } from "../src/lib/time.js";

describe("time helpers", () => {
  it("normalizes clocks", () => {
    expect(normalizeClock("6:30 AM")).toBe("06:30");
    expect(normalizeClock("12:05 PM")).toBe("12:05");
    expect(normalizeClock("12:05 AM")).toBe("00:05");
    expect(normalizeClock("18:30:00")).toBe("18:30");
    expect(normalizeClock("25:00")).toBeNull();
    expect(normalizeClock("2026-09-26T08:20:00-07:00")).toBeNull();
  });
  it("converts instants into Vancouver local date/time", () => {
    expect(localDateTime("2026-09-26T15:20:00Z", "America/Vancouver")).toEqual({ date: "2026-09-26", time: "08:20" });
    expect(localDateTime("2026-09-26T08:20:00", "America/Vancouver")).toEqual({ date: "2026-09-26", time: "08:20" });
    expect(localDateTime("2026-12-01T07:00:00Z", "America/Vancouver")).toEqual({ date: "2026-11-30", time: "23:00" });
  });
  it("does calendar math", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(daysBetween("2026-09-20", "2026-09-26")).toBe(6);
    expect(todayIn("America/Vancouver", new Date("2026-09-21T05:00:00Z"))).toBe("2026-09-20");
  });
  it("formats platform-specific dates", () => {
    expect(toJsDateString("2026-06-12")).toBe("Fri Jun 12 2026");
    expect(toUnpaddedDate("2026-06-02")).toBe("2026-6-2");
  });
});
