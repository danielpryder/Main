import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseClubPage, parseV2Slots, parseClassicSlots, ChronogolfProvider } from "../src/providers/chronogolf.js";
import { parseCpsSlots, CpsProvider } from "../src/providers/cps.js";
import { parseV3Html, CpsV3Provider } from "../src/providers/cpsV3.js";
import { createMockFetch } from "../src/lib/mockFetch.js";
import type { ProviderContext } from "../src/providers/types.js";

const FIX = resolve(import.meta.dirname, "fixtures");
const read = (n: string) => readFileSync(resolve(FIX, n), "utf8");
const TZ = "America/Vancouver";
const Q = { date: "2026-09-26", players: 2, holes: 18 };
const ctx = (): ProviderContext => ({ timezone: TZ, timeoutMs: 5000, fetch: createMockFetch(), log: () => {} });

describe("chronogolf parsing", () => {
  it("discovers course UUIDs and the numeric club id from the club page", () => {
    const d = parseClubPage(read("chronogolf-club.html"));
    expect(d.clubId).toBe("1234");
    expect(d.courses).toEqual([
      { uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Fraserview", holes: 18 },
      { uuid: "16fd2706-8baf-433b-82eb-8c7fada847da", name: "Fraserview Front 9", holes: 9 },
    ]);
  });

  it("parses v2 slots, converting offsets to local time and dropping full/restricted/next-day slots", () => {
    const times = parseV2Slots(JSON.parse(read("chronogolf-v2.json")), Q, TZ, "fraserview-golf-course", new Map())!;
    expect(times.map((t) => t.time)).toEqual(["08:20", "08:30", "10:40"]);
    expect(times[0]).toMatchObject({ openSpots: 4, price: 89, holes: 18 });
    expect(times[0].bookingUrl).toContain("teetime=a1b2c3d4-0000-4000-8000-000000000001");
  });

  it("parses classic slots and treats out_of_capacity as not bookable for the requested party", () => {
    const times = parseClassicSlots(JSON.parse(read("chronogolf-classic-teetimes.json")), Q, TZ, "https://x", "Ridge")!;
    expect(times.map((t) => t.time)).toEqual(["08:30", "09:20"]);
    expect(times[0]).toMatchObject({ openSpots: 2, price: 120, courseName: "Ridge" });
  });

  it("returns null for an unrecognized payload", () => {
    expect(parseV2Slots({ nope: 1 }, Q, TZ, "x", new Map())).toBeNull();
  });
});

describe("chronogolf provider end-to-end (mock fetch)", () => {
  it("uses the v2 API when the club page exposes course UUIDs", async () => {
    const p = new ChronogolfProvider({ type: "chronogolf", slug: "fraserview-golf-course" }, ctx());
    const r = await p.fetchDay(Q);
    expect(r.status).toBe("ok");
    expect(r.times.map((t) => t.time)).toEqual(["08:20", "08:30", "10:40"]);
  });

  it("falls back to the classic API, probing player types and merging multi-course clubs", async () => {
    const p = new ChronogolfProvider({ type: "chronogolf", slug: "northview-golf-country-club" }, ctx());
    const r = await p.fetchDay(Q);
    expect(r.status).toBe("ok");
    expect(r.times.map((t) => `${t.time}${t.courseName ? ` ${t.courseName}` : ""}`)).toEqual(["08:30 Ridge", "08:35 Canal", "09:20 Ridge", "09:25 Canal"]);
  });
});

describe("cps v4", () => {
  it("parses tee times with per-slot player capacity", () => {
    const times = parseCpsSlots(JSON.parse(read("cps-teetimes.json")), Q, TZ, "https://x");
    expect(times.map((t) => [t.time, t.openSpots, t.price])).toEqual([
      ["07:50", 4, 95],
      ["08:40", 2, 95],
      ["09:30", 3, 95],
      ["13:10", 4, 80],
    ]);
  });

  it("fetches through the transaction/register flow", async () => {
    const p = new CpsProvider({ type: "cps", site: "northlands", courseIds: "1" }, ctx());
    const r = await p.fetchDay(Q);
    expect(r.status).toBe("ok");
    expect(r.times).toHaveLength(4);
  });

  it("reports a Cloudflare block as an error rather than an empty sheet", async () => {
    const p = new CpsProvider({ type: "cps", site: "morgancreekbc" }, ctx());
    const r = await p.fetchDay(Q);
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/403/);
  });
});

describe("cps v3", () => {
  it("scrapes tee times, prices and player counts out of the HTML, de-duplicated", () => {
    const times = parseV3Html(read("cps-v3.html"), Q, "https://x");
    expect(times.map((t) => [t.time, t.openSpots, t.price])).toEqual([
      ["07:30", 2, 89],
      ["08:15", 4, 89],
      ["12:45", 3, 69],
    ]);
  });

  it("fetches through the session redirect", async () => {
    const p = new CpsV3Provider({ type: "cps_v3", baseUrl: "https://w.cps.golf/KingsLinksV3" }, ctx());
    const r = await p.fetchDay(Q);
    expect(r.status).toBe("ok");
    expect(r.times).toHaveLength(3);
  });
});
