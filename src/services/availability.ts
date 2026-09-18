import { TtlCache } from "../lib/cache.js";
import { addDays, daysBetween, fromMinutes, isIsoDate, toMinutes, todayIn } from "../lib/time.js";
import { createProvider } from "../providers/index.js";
import type { AppConfig, CourseConfig, FetchResult, Provider, ProviderContext, TeeTime } from "../providers/types.js";

export interface AvailabilityRequest {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM target tee time; omit for "any time that day" */
  time?: string;
  /** 1-4 */
  players: number;
  /** +/- minutes around `time` to include (default 90) */
  windowMinutes?: number;
  holes?: number;
  /** Restrict to these course ids */
  courseIds?: string[];
}

export interface MatchedTeeTime extends TeeTime {
  /** Minutes from the requested time (negative = earlier); null when no time was requested */
  deltaMinutes: number | null;
  /** true = platform confirms room for the group, null = platform does not report open spots */
  fits: boolean | null;
}

export type CourseStatus = "ok" | "manual" | "error";

export interface CourseAvailability {
  course: Pick<CourseConfig, "id" | "name" | "city" | "bookingUrl" | "bookingWindowDays" | "notes">;
  status: CourseStatus;
  provider?: string;
  message?: string;
  /** Requested date is further out than the course's public booking window */
  beyondWindow: boolean;
  /** Date on which public booking for the requested date opens (when beyondWindow) */
  bookingOpens?: string;
  /** Tee times matching the time window and group size, nearest first */
  times: MatchedTeeTime[];
  /** Total bookable times that day before filtering */
  totalThatDay: number;
  fetchedAt: string;
}

export interface AvailabilityResponse {
  request: { date: string; time: string | null; players: number; windowMinutes: number; holes: number; from: string | null; to: string | null };
  today: string;
  courses: CourseAvailability[];
}

export interface ServiceOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => Date;
}

export class ValidationError extends Error {}

interface DayQuery {
  date: string;
  players: number;
  holes: number;
}

export class AvailabilityService {
  private readonly providers = new Map<string, Provider[]>();
  private readonly cache: TtlCache<FetchResult>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly config: AppConfig,
    opts: ServiceOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? (() => new Date());
    this.cache = new TtlCache<FetchResult>(opts.cacheTtlMs ?? 120_000);
    const ctx: ProviderContext = {
      timezone: config.timezone,
      timeoutMs: this.timeoutMs,
      fetch: opts.fetch ?? fetch,
      log: opts.log ?? (() => {}),
    };
    for (const course of config.courses) {
      this.providers.set(
        course.id,
        course.providers.map((p) => createProvider(p, ctx)),
      );
    }
  }

  get courses(): CourseConfig[] {
    return this.config.courses;
  }

  get timezone(): string {
    return this.config.timezone;
  }

  async check(req: AvailabilityRequest): Promise<AvailabilityResponse> {
    const players = clampInt(req.players, 1, 4, 2);
    const windowMinutes = clampInt(req.windowMinutes ?? 90, 0, 12 * 60, 90);
    const holes = req.holes === 9 ? 9 : 18;
    if (!isIsoDate(req.date)) throw new ValidationError("date must be YYYY-MM-DD");
    const time = req.time ? normalizeRequestedTime(req.time) : null;
    const today = todayIn(this.config.timezone, this.now());
    if (daysBetween(today, req.date) < 0) throw new ValidationError("date is in the past");

    const wanted = req.courseIds?.length ? this.config.courses.filter((c) => req.courseIds!.includes(c.id)) : this.config.courses;
    if (!wanted.length) throw new ValidationError("no matching courses");

    const from = time !== null ? Math.max(0, toMinutes(time) - windowMinutes) : null;
    const to = time !== null ? Math.min(24 * 60 - 1, toMinutes(time) + windowMinutes) : null;
    const q: DayQuery = { date: req.date, players, holes };

    const results = await Promise.all(wanted.map((course) => this.checkCourse(course, q, time, from, to, today)));
    return {
      request: { date: req.date, time, players, windowMinutes, holes, from: from !== null ? fromMinutes(from) : null, to: to !== null ? fromMinutes(to) : null },
      today,
      courses: results,
    };
  }

  private async checkCourse(course: CourseConfig, q: DayQuery, time: string | null, from: number | null, to: number | null, today: string): Promise<CourseAvailability> {
    const beyondWindow = course.bookingWindowDays !== null && daysBetween(today, q.date) > course.bookingWindowDays;
    const key = `${course.id}|${q.date}|${q.players}|${q.holes}`;
    const result = await this.cache.getOrLoad(key, () => this.fetchWithFallback(course, q));

    const targetMin = time !== null ? toMinutes(time) : null;
    const times: MatchedTeeTime[] = result.times
      .filter((t) => t.date === q.date)
      .filter((t) => from === null || to === null || (toMinutes(t.time) >= from && toMinutes(t.time) <= to))
      .map((t) => ({
        ...t,
        deltaMinutes: targetMin === null ? null : toMinutes(t.time) - targetMin,
        fits: t.openSpots === null ? null : t.openSpots >= q.players,
      }))
      .filter((t) => t.fits !== false)
      .sort((a, b) => {
        if (a.deltaMinutes === null || b.deltaMinutes === null) return a.time.localeCompare(b.time);
        return Math.abs(a.deltaMinutes) - Math.abs(b.deltaMinutes) || a.time.localeCompare(b.time);
      });

    return {
      course: { id: course.id, name: course.name, city: course.city, bookingUrl: course.bookingUrl, bookingWindowDays: course.bookingWindowDays, notes: course.notes },
      status: result.status,
      provider: result.provider,
      message: result.message,
      beyondWindow,
      bookingOpens: beyondWindow ? addDays(q.date, -(course.bookingWindowDays as number)) : undefined,
      times,
      totalThatDay: result.times.length,
      fetchedAt: this.now().toISOString(),
    };
  }

  /** Try each configured provider in order; the first "ok" result wins. */
  private async fetchWithFallback(course: CourseConfig, q: DayQuery): Promise<FetchResult> {
    const providers = this.providers.get(course.id) ?? [];
    let last: FetchResult = { status: "error", provider: "none", times: [], message: "no providers configured" };
    for (const p of providers) {
      const r = await withTimeout(p.fetchDay(q), this.timeoutMs * 2, `${p.name} timed out`).catch(
        (err: Error): FetchResult => ({ status: "error", provider: p.name, times: [], message: err.message }),
      );
      if (r.status === "ok") return r;
      // Prefer a "manual" (link-out) answer over an error so the UI shows the booking link rather than a failure.
      if (last.status !== "manual" || r.status === "manual") last = r;
    }
    return last;
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeRequestedTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ValidationError("time must be HH:MM (24h)");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
