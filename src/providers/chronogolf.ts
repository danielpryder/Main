/**
 * Chronogolf (Lightspeed Golf) adapter. Used by Furry Creek, Northview, Fraserview,
 * and as a fallback for Morgan Creek.
 *
 * Two API generations exist and both are open (no login):
 *
 *  Modern (v2, UUID course ids; what the current chronogolf.com club pages call):
 *    GET /marketplace/v2/teetimes?start_date=YYYY-MM-DD&course_ids=<uuid>[,<uuid>]&holes=18&page=N
 *    UUIDs come from the __NEXT_DATA__ blob on https://www.chronogolf.com/club/<slug>.
 *
 *  Classic (numeric ids; what the older /club/<id>/widget calls):
 *    GET /marketplace/clubs/<clubId>/courses
 *    GET /marketplace/organizations/<clubId>/affiliation_types
 *    GET /marketplace/clubs/<clubId>/teetimes?date=YYYY-MM-DD&course_id=<id>&nb_holes=18
 *          &affiliation_type_ids[]=<aff>   (repeated once per player)
 *    Slots carry out_of_capacity / restrictions / green_fees[] (one entry per player).
 *
 * Discovery is automatic on first use and cached per process; pin ids in
 * config/courses.json (courseUuids, or clubId + courseId + affiliationTypeId) to skip it.
 */
import { HttpClient, HttpError, buildQuery } from "../lib/http.js";
import { localDateTime, normalizeClock } from "../lib/time.js";
import type { ChronogolfConfig, FetchQuery, FetchResult, Provider, ProviderContext, TeeTime } from "./types.js";

export const CHRONOGOLF_BASE = "https://www.chronogolf.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGES = 6;

interface DiscoveredCourse {
  uuid: string;
  name: string;
  holes: number;
}

export interface ChronogolfDiscovery {
  clubId: string | null;
  courses: DiscoveredCourse[];
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(node: unknown, visit: (o: Json) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
  } else if (isObj(node)) {
    visit(node);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

/** Pull course UUIDs and (if present) a numeric club id out of the club page HTML. */
export function parseClubPage(html: string): ChronogolfDiscovery {
  const out: ChronogolfDiscovery = { clubId: null, courses: [] };
  const seen = new Set<string>();
  const blobs: unknown[] = [];

  const next = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (next) {
    try {
      blobs.push(JSON.parse(next[1]));
    } catch {
      /* ignore */
    }
  }
  // Older pages inline `window.__STATE__ = {...}` style objects; grab anything that parses.
  for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* ignore */
    }
  }

  for (const blob of blobs) {
    walk(blob, (o) => {
      const holes = o.holes;
      const name = o.name;
      const id = typeof o.uuid === "string" && UUID_RE.test(o.uuid) ? o.uuid : typeof o.id === "string" && UUID_RE.test(o.id) ? o.id : null;
      if (id && typeof name === "string" && typeof holes === "number" && !seen.has(id)) {
        seen.add(id);
        out.courses.push({ uuid: id, name, holes });
      }
      if (out.clubId === null && typeof o.slug === "string" && typeof o.id === "number" && "courses" in o) {
        out.clubId = String(o.id);
      }
    });
  }

  if (out.clubId === null) {
    const m = /\/club\/(\d+)\/widget/.exec(html) ?? /"club_id"\s*:\s*(\d+)/.exec(html) ?? /"clubId"\s*:\s*(\d+)/.exec(html);
    if (m) out.clubId = m[1];
  }
  return out;
}

function firstNumber(node: unknown, keys: string[], depth = 0): number | null {
  if (depth > 2) return null;
  if (isObj(node)) {
    for (const k of keys) {
      const v = node[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    }
    for (const v of Object.values(node)) {
      if (isObj(v) || Array.isArray(v)) {
        const found = firstNumber(v, keys, depth + 1);
        if (found !== null) return found;
      }
    }
  } else if (Array.isArray(node)) {
    for (const v of node) {
      const found = firstNumber(v, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function slotTime(slot: Json, date: string, timezone: string): { date: string; time: string } | null {
  for (const key of ["start_time", "startTime", "time", "teetime", "teeTime", "date_time", "dateTime", "startDateTime", "start_at", "starts_at"]) {
    const raw = slot[key];
    if (typeof raw !== "string" || !raw) continue;
    const clock = normalizeClock(raw);
    if (clock) return { date: typeof slot.date === "string" ? slot.date : date, time: clock };
    const local = localDateTime(raw, timezone);
    if (local) return local;
  }
  return null;
}

/** Sum of per-player green fees, divided back to a per-player price. */
function slotPrice(slot: Json): number | null {
  const fees = slot.green_fees;
  if (Array.isArray(fees) && fees.length) {
    let total = 0;
    for (const f of fees) {
      const v = isObj(f) ? firstNumber(f, ["green_fee", "greenFee", "price", "amount"]) : null;
      if (v === null) return null;
      total += v;
    }
    return Math.round((total / fees.length) * 100) / 100;
  }
  return firstNumber(slot, ["green_fee", "greenFee", "price", "rate", "amount"]);
}

function slotSpots(slot: Json): number | null {
  return firstNumber(slot, ["free_slots", "freeSlots", "available_spots", "availableSpots", "available_players", "max_players", "maxPlayers"]);
}

export function extractSlots(data: unknown): Json[] | null {
  if (Array.isArray(data)) return data.filter(isObj);
  if (isObj(data)) {
    for (const key of ["teetimes", "tee_times", "data", "results", "items"]) {
      const v = data[key];
      if (Array.isArray(v)) return v.filter(isObj);
    }
  }
  return null;
}

export function parseV2Slots(data: unknown, query: FetchQuery, timezone: string, slug: string, courseNames: Map<string, string>): TeeTime[] | null {
  const slots = extractSlots(data);
  if (!slots) return null;
  const out: TeeTime[] = [];
  for (const slot of slots) {
    if (slot.out_of_capacity === true) continue;
    if (Array.isArray(slot.restrictions) && slot.restrictions.length) continue;
    const when = slotTime(slot, query.date, timezone);
    if (!when || when.date !== query.date) continue;
    const id = typeof slot.id === "string" ? slot.id : typeof slot.uuid === "string" ? slot.uuid : null;
    const courseId = typeof slot.course_id === "string" ? slot.course_id : typeof slot.course_uuid === "string" ? slot.course_uuid : null;
    out.push({
      date: when.date,
      time: when.time,
      openSpots: slotSpots(slot),
      price: slotPrice(slot),
      holes: typeof slot.holes === "number" ? slot.holes : query.holes,
      bookingUrl: id ? `${CHRONOGOLF_BASE}/club/${slug}?step=options&teetime=${encodeURIComponent(id)}` : `${CHRONOGOLF_BASE}/club/${slug}`,
      courseName: courseId ? courseNames.get(courseId) : undefined,
    });
  }
  return out;
}

export function parseClassicSlots(data: unknown, query: FetchQuery, timezone: string, bookingUrl: string, courseName?: string): TeeTime[] | null {
  const slots = extractSlots(data);
  if (!slots) return null;
  const out: TeeTime[] = [];
  for (const slot of slots) {
    if (slot.out_of_capacity === true) continue;
    if (Array.isArray(slot.restrictions) && slot.restrictions.length) continue;
    const when = slotTime(slot, query.date, timezone);
    if (!when || when.date !== query.date) continue;
    out.push({
      date: when.date,
      time: when.time,
      // We asked for exactly `players` seats and the slot was not out_of_capacity.
      openSpots: slotSpots(slot) ?? query.players,
      price: slotPrice(slot),
      holes: query.holes,
      bookingUrl,
      courseName,
    });
  }
  return out;
}

export class ChronogolfProvider implements Provider {
  readonly name = "chronogolf";
  private readonly http: HttpClient;
  private discovery: Promise<ChronogolfDiscovery> | null = null;
  private classicCourses: Promise<Array<{ id: string; name: string; holes: number }>> | null = null;
  private affiliationId: string | null = null;

  constructor(
    private readonly cfg: ChronogolfConfig,
    private readonly ctx: ProviderContext,
  ) {
    this.http = new HttpClient(ctx.fetch, ctx.timeoutMs);
    if (cfg.affiliationTypeId !== undefined) this.affiliationId = String(cfg.affiliationTypeId);
  }

  get clubUrl(): string {
    return `${CHRONOGOLF_BASE}/club/${this.cfg.slug}`;
  }

  discover(): Promise<ChronogolfDiscovery> {
    if (!this.discovery) {
      this.discovery = (async () => {
        const { text } = await this.http.text(this.clubUrl, { headers: { Accept: "text/html,application/xhtml+xml" } });
        const found = parseClubPage(text);
        if (this.cfg.clubId !== undefined) found.clubId = String(this.cfg.clubId);
        this.ctx.log(`chronogolf ${this.cfg.slug}: discovered clubId=${found.clubId ?? "?"} courses=${found.courses.map((c) => `${c.name}(${c.holes})`).join(",") || "none"}`);
        return found;
      })().catch((err) => {
        this.discovery = null;
        throw err;
      });
    }
    return this.discovery;
  }

  async fetchDay(query: FetchQuery): Promise<FetchResult> {
    const errors: string[] = [];

    // 1. Modern v2 API with UUID course ids.
    try {
      const v2 = await this.fetchV2(query);
      if (v2) return v2;
    } catch (err) {
      errors.push(`v2: ${(err as Error).message}`);
    }

    // 2. Classic numeric API.
    try {
      const classic = await this.fetchClassic(query);
      if (classic) return classic;
    } catch (err) {
      errors.push(`classic: ${(err as Error).message}`);
    }

    return {
      status: "error",
      provider: this.name,
      times: [],
      message: errors.length ? errors.join(" | ") : `No Chronogolf course ids found for ${this.cfg.slug}; run npm run discover and pin them in config/courses.json`,
    };
  }

  private async fetchV2(query: FetchQuery): Promise<FetchResult | null> {
    let uuids = this.cfg.courseUuids ?? [];
    const names = new Map<string, string>();
    if (!uuids.length) {
      const d = await this.discover();
      const matching = d.courses.filter((c) => c.holes === query.holes);
      const chosen = matching.length ? matching : d.courses;
      uuids = chosen.map((c) => c.uuid);
      // Only label slots with a course name when the club actually sells several courses.
      if (chosen.length > 1) for (const c of d.courses) names.set(c.uuid, c.name);
    }
    if (!uuids.length) return null;

    const times: TeeTime[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${CHRONOGOLF_BASE}/marketplace/v2/teetimes?${buildQuery({
        start_date: query.date,
        course_ids: uuids.join(","),
        holes: query.holes,
        page,
      })}`;
      const data = await this.http.json(url, { headers: { Referer: this.clubUrl } });
      const parsed = parseV2Slots(data, query, this.ctx.timezone, this.cfg.slug, names);
      if (parsed === null) throw new Error(`unrecognized payload: ${JSON.stringify(data).slice(0, 200)}`);
      const slots = extractSlots(data) ?? [];
      if (!slots.length) break;
      times.push(...parsed);
      if (slots.length < 20) break; // last page
    }
    return { status: "ok", provider: this.name, times: dedupe(times) };
  }

  private async fetchClassic(query: FetchQuery): Promise<FetchResult | null> {
    let clubId = this.cfg.clubId !== undefined ? String(this.cfg.clubId) : null;
    if (!clubId) clubId = (await this.discover()).clubId;
    if (!clubId) return null;

    const widget = `${CHRONOGOLF_BASE}/club/${clubId}/widget`;
    const headers = { Referer: widget };

    let courses: Array<{ id: string; name: string; holes: number }>;
    if (this.cfg.courseId !== undefined) {
      courses = [{ id: String(this.cfg.courseId), name: "", holes: query.holes }];
    } else {
      if (!this.classicCourses) {
        this.classicCourses = this.http
          .json<unknown>(`${CHRONOGOLF_BASE}/marketplace/clubs/${clubId}/courses`, { headers })
          .then((data) => (Array.isArray(data) ? data : []).filter(isObj).map((c) => ({ id: String(c.id), name: String(c.name ?? ""), holes: Number(c.holes ?? 18) })));
      }
      const all = await this.classicCourses;
      const matching = all.filter((c) => c.holes === query.holes);
      courses = matching.length ? matching : all;
    }
    if (!courses.length) return null;

    const affCandidates = await this.affiliationCandidates(clubId, headers);
    if (!affCandidates.length) throw new Error("no affiliation types found");

    const times: TeeTime[] = [];
    let anySlots = false;
    for (const aff of affCandidates) {
      const affParams = Array.from({ length: query.players }, () => `affiliation_type_ids%5B%5D=${encodeURIComponent(aff)}`).join("&");
      for (const course of courses) {
        const url = `${CHRONOGOLF_BASE}/marketplace/clubs/${clubId}/teetimes?${buildQuery({ date: query.date, course_id: course.id, nb_holes: query.holes })}&${affParams}`;
        let data: unknown;
        try {
          data = await this.http.json(url, { headers });
        } catch (err) {
          if (err instanceof HttpError && err.status === 429) throw new Error("rate limited (429) by Chronogolf; retry shortly");
          throw err;
        }
        if (isObj(data) && "error" in data) throw new Error(`API error: ${JSON.stringify(data.error).slice(0, 150)}`);
        const slots = extractSlots(data) ?? [];
        if (slots.length) anySlots = true;
        const parsed = parseClassicSlots(data, query, this.ctx.timezone, widget, courses.length > 1 ? course.name : undefined) ?? [];
        times.push(...parsed);
      }
      if (times.length || anySlots) {
        this.affiliationId = aff; // remember the player type that works
        break;
      }
    }
    return { status: "ok", provider: this.name, times: dedupe(times) };
  }

  private async affiliationCandidates(clubId: string, headers: Record<string, string>): Promise<string[]> {
    if (this.affiliationId) return [this.affiliationId];
    const data = await this.http.json<unknown>(`${CHRONOGOLF_BASE}/marketplace/organizations/${clubId}/affiliation_types`, { headers });
    const list = (Array.isArray(data) ? data : []).filter(isObj).map((a) => ({ id: String(a.id), name: String(a.name ?? "") }));
    const score = (n: string) => (/public|visitor|green\s*fee|guest|non-?member/i.test(n) ? 0 : /member/i.test(n) ? 2 : 1);
    return list.sort((a, b) => score(a.name) - score(b.name)).slice(0, 4).map((a) => a.id);
  }
}

function dedupe(times: TeeTime[]): TeeTime[] {
  const seen = new Map<string, TeeTime>();
  for (const t of times) {
    const key = `${t.date} ${t.time} ${t.courseName ?? ""}`;
    const prev = seen.get(key);
    if (!prev || (prev.openSpots ?? 0) < (t.openSpots ?? 0)) seen.set(key, t);
  }
  return [...seen.values()].sort((a, b) => a.time.localeCompare(b.time));
}
