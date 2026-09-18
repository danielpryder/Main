/**
 * Legacy Club Prophet "v3" adapter (server-rendered ASP.NET site). Used by Kings Links:
 *   https://w.cps.golf/KingsLinksV3/(S(<session>))/Home/nIndex?CourseId=1&Date=2026-9-20&Time=AnyTime&Player=2&Hole=18
 *
 * The first request (without the session segment) redirects to a URL carrying (S(...)),
 * but the redirect drops the query string, so we request again against the session URL
 * and scrape tee times out of the HTML.
 */
import { HttpClient, buildQuery } from "../lib/http.js";
import { normalizeClock, toUnpaddedDate } from "../lib/time.js";
import type { CpsV3Config, FetchQuery, FetchResult, Provider, ProviderContext, TeeTime } from "./types.js";

const ATTR_RE = /teetime=['"](\d{1,2}:\d{2}\s*[AP]M)['"]/gi;
const TIME_RE = /\b(\d{1,2}:\d{2}\s*[AP]M)\b/gi;
const PRICE_RE = /\$\s*(\d+(?:\.\d{2})?)/;
const PLAYERS_RE = /(\d)\s*(?:player|golfer)s?\s*(?:available|open)/i;

export function parseV3Html(html: string, query: FetchQuery, bookingUrl: string): TeeTime[] {
  const seen = new Set<string>();
  const out: TeeTime[] = [];
  let matches = [...html.matchAll(ATTR_RE)];
  if (!matches.length) matches = [...html.matchAll(TIME_RE)];
  for (const m of matches) {
    const clock = normalizeClock(m[1]);
    if (!clock || seen.has(clock)) continue;
    seen.add(clock);
    const window = html.slice(m.index ?? 0, (m.index ?? 0) + 400);
    const price = PRICE_RE.exec(window);
    const players = PLAYERS_RE.exec(window);
    out.push({
      date: query.date,
      time: clock,
      // The page was asked for `players` seats, so anything listed fits at least that many.
      openSpots: players ? Number(players[1]) : query.players,
      price: price ? Number(price[1]) : null,
      holes: query.holes,
      bookingUrl,
    });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export class CpsV3Provider implements Provider {
  readonly name = "cps_v3";
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(
    private readonly cfg: CpsV3Config,
    ctx: ProviderContext,
  ) {
    this.http = new HttpClient(ctx.fetch, ctx.timeoutMs);
    this.base = cfg.baseUrl.replace(/\/+$/, "");
  }

  async fetchDay(query: FetchQuery): Promise<FetchResult> {
    const params = buildQuery({
      CourseId: this.cfg.courseId ?? "1",
      Date: toUnpaddedDate(query.date),
      Time: "AnyTime",
      Player: query.players,
      Hole: query.holes,
    });
    const headers = { Accept: "text/html,application/xhtml+xml" };
    try {
      const first = await this.http.text(`${this.base}/Home/nIndex?${params}`, { headers });
      const sessionUrl = first.res.url.split("?")[0];
      const bookingUrl = `${sessionUrl}?${params}`;
      const html = sessionUrl && sessionUrl !== `${this.base}/Home/nIndex` ? (await this.http.text(bookingUrl, { headers })).text : first.text;
      if (/cf-browser-verification|Just a moment|challenge-platform/i.test(html)) {
        return { status: "error", provider: this.name, times: [], message: "Booking site returned a Cloudflare challenge page; check availability on the booking site." };
      }
      return { status: "ok", provider: this.name, times: parseV3Html(html, query, `${this.base}/Home/nIndex?${params}`) };
    } catch (err) {
      return { status: "error", provider: this.name, times: [], message: `CPS v3 request failed: ${(err as Error).message}` };
    }
  }
}
