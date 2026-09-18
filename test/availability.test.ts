import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { createMockFetch } from "../src/lib/mockFetch.js";
import { AvailabilityService, ValidationError } from "../src/services/availability.js";

const NOW = () => new Date("2026-09-20T18:00:00Z"); // Sept 20, 11:00 Vancouver
const make = () => new AvailabilityService(loadConfig(), { fetch: createMockFetch(), now: NOW, timeoutMs: 5000 });

describe("AvailabilityService", () => {
  it("fans out to every course, filters by time window and party size, and sorts nearest-first", async () => {
    const svc = make();
    const res = await svc.check({ date: "2026-09-26", time: "09:00", players: 3, windowMinutes: 60 });
    expect(res.request).toMatchObject({ from: "08:00", to: "10:00", players: 3, holes: 18 });
    const by = Object.fromEntries(res.courses.map((c) => [c.course.id, c]));

    // Fraserview (chronogolf v2): 08:20 (4 open) fits; 08:30 has 1 spot -> excluded; 10:40 outside window.
    expect(by.fraserview.status).toBe("ok");
    expect(by.fraserview.times.map((t) => t.time)).toEqual(["08:20"]);
    expect(by.fraserview.totalThatDay).toBe(3);

    // Northlands (cps): 07:50 out of window; 08:40 only 2 open; 09:30 (3 open) fits.
    expect(by.northlands.times.map((t) => [t.time, t.deltaMinutes])).toEqual([["09:30", 30]]);

    // Kings Links (cps v3): 08:15 has 4; 07:30 out of window.
    expect(by["kings-links"].times.map((t) => t.time)).toEqual(["08:15"]);

    // Morgan Creek: CPS site is blocked in the mock, so the Chronogolf fallback answers.
    expect(by["morgan-creek"].status).toBe("ok");
    expect(by["morgan-creek"].provider).toBe("chronogolf");

    // Link-only courses.
    expect(by["mayfair-lakes"].status).toBe("manual");
    expect(by.redwoods.status).toBe("manual");
  });

  it("returns every time of the day when no time is given", async () => {
    const res = await svc().check({ date: "2026-09-26", players: 1 });
    const fv = res.courses.find((c) => c.course.id === "fraserview")!;
    expect(fv.times.map((t) => t.time)).toEqual(["08:20", "08:30", "10:40"]);
    expect(fv.times.every((t) => t.deltaMinutes === null)).toBe(true);
  });

  it("flags dates beyond a course's public booking window", async () => {
    const res = await svc().check({ date: "2026-09-30", players: 2, courseIds: ["fraserview", "redwoods"] });
    const fv = res.courses.find((c) => c.course.id === "fraserview")!;
    expect(fv.beyondWindow).toBe(true);
    expect(fv.bookingOpens).toBe("2026-09-25");
    const rw = res.courses.find((c) => c.course.id === "redwoods")!;
    expect(rw.beyondWindow).toBe(false);
  });

  it("rejects bad input", async () => {
    await expect(svc().check({ date: "26/09/2026", players: 2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc().check({ date: "2026-09-01", players: 2 })).rejects.toThrow(/past/);
    await expect(svc().check({ date: "2026-09-26", time: "25:00", players: 2 })).rejects.toThrow(/HH:MM/);
  });

  it("caches provider results per course/date/party", async () => {
    const calls: string[] = [];
    const s = new AvailabilityService(loadConfig(), { fetch: createMockFetch({ log: (u) => calls.push(u) }), now: NOW });
    await s.check({ date: "2026-09-26", players: 2, courseIds: ["fraserview"] });
    const n = calls.length;
    await s.check({ date: "2026-09-26", time: "10:00", players: 2, courseIds: ["fraserview"] });
    expect(calls.length).toBe(n);
  });
});

function svc() {
  return make();
}
