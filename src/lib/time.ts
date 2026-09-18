/** Date/time helpers. Tee times are handled as local strings in the course timezone. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
const AMPM = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]?\.?$/;

export function isIsoDate(s: string): boolean {
  return ISO_DATE.test(s);
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Minutes since midnight for an HH:MM string. */
export function toMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMinutes(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/** Normalize "6:30 AM", "06:30", "18:30:00" to "HH:MM". Returns null if unparseable. */
export function normalizeClock(raw: string): string | null {
  const s = raw.trim();
  let m = AMPM.exec(s);
  if (m) {
    let h = Number(m[1]);
    const ampm = m[3].toLowerCase();
    if (ampm === "p" && h !== 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
    return `${pad2(h)}:${m[2]}`;
  }
  m = HHMM.exec(s);
  if (m) {
    const h = Number(m[1]);
    if (h > 23 || Number(m[2]) > 59) return null;
    return `${pad2(h)}:${m[2]}`;
  }
  return null;
}

/** Split an ISO-ish datetime into local date + time in the given timezone. */
export function localDateTime(input: string | Date, timezone: string): { date: string; time: string } | null {
  let d: Date;
  if (input instanceof Date) {
    d = input;
  } else {
    const s = input.trim();
    // A bare "YYYY-MM-DDTHH:MM[:SS]" with no offset is already local course time.
    const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
    if (bare) return { date: bare[1], time: bare[2] };
    d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

/** Today's date (YYYY-MM-DD) in a timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return localDateTime(now, timezone)!.date;
}

/** Add days to a YYYY-MM-DD string (calendar arithmetic, timezone-agnostic). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri Jun 12 2026" — the format CPS v4 expects for searchDate. */
export function toJsDateString(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]} ${MONTHS[m - 1]} ${pad2(d)} ${y}`;
}

/** "2026-6-12" — unpadded form used by the CPS v3 sites. */
export function toUnpaddedDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${y}-${m}-${d}`;
}
