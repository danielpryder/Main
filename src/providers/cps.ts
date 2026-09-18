/**
 * Club Prophet Systems "Online Reservation v4" adapter (the *.cps.golf/onlineresweb sites).
 * Used by Northlands (northlands.cps.golf) and Morgan Creek (morgancreekbc.cps.golf).
 *
 * The Angular front end calls:
 *   POST /onlineres/onlineapi/api/v1/onlinereservation/RegisterTransactionId  {"transactionId": <guid>}
 *   GET  /onlineres/onlineapi/api/v1/onlinereservation/TeeTimes
 *          ?searchDate=Fri Jun 12 2026&holes=18&numberOfPlayer=0&courseIds=1&searchTimeType=0
 *          &transactionId=<guid>&teeOffTimeMin=0&teeOffTimeMax=23&isChangeTeeOffTime=true
 *          &teeSheetSearchView=5&classCode=R&defaultOnlineRate=N&isUseCapacityPricing=false
 *          &memberStoreId=1&searchType=1
 *   headers: x-apikey <guid, per site>, client-id onlineresweb, x-componentid 1, x-productid 1,
 *            x-moduleid 7, x-siteid 1, x-terminalid 3, Authorization: Bearer <anonymous token>
 *
 * The anonymous bearer token comes from the site's IdentityServer
 * (/identityapi/connect/authorize, client "onlinereswebshortlived", implicit flow).
 * Some CPS sites sit behind a strict Cloudflare tier and answer 403 to anything that is
 * not a real browser; those results come back as status "error" with the booking link.
 */
import { randomUUID } from "node:crypto";
import { HttpClient, buildQuery } from "../lib/http.js";
import { localDateTime, normalizeClock, toJsDateString } from "../lib/time.js";
import type { CpsConfig, FetchQuery, FetchResult, Provider, ProviderContext, TeeTime } from "./types.js";

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function extractCpsSlots(data: unknown): Json[] {
  if (Array.isArray(data)) return data.filter(isObj);
  if (isObj(data)) {
    for (const key of ["teeTimes", "teetimes", "data", "result", "items", "availableTeeTimes"]) {
      const v = data[key];
      if (Array.isArray(v)) return v.filter(isObj);
    }
  }
  return [];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function parseCpsSlots(data: unknown, query: FetchQuery, timezone: string, bookingUrl: string): TeeTime[] {
  const out: TeeTime[] = [];
  for (const slot of extractCpsSlots(data)) {
    const raw = slot.startTime ?? slot.teeTime ?? slot.time ?? slot.startDateTime ?? slot.teeTimeDisplay;
    if (typeof raw !== "string" || !raw) continue;
    let when = localDateTime(raw, timezone);
    if (!when) {
      const clock = normalizeClock(raw);
      if (clock) when = { date: query.date, time: clock };
    }
    if (!when || when.date !== query.date) continue;

    let spots: unknown = slot.availableParticipantNo ?? slot.avaliableParticipantNo ?? slot.availableSpots ?? slot.maxPlayer;
    if (Array.isArray(spots)) spots = spots.length ? Math.max(...spots.map((s) => Number(s) || 0)) : null;
    const price = num(slot.shItemPrice) ?? num(slot.price) ?? num(slot.greenFee) ?? num(slot.greenFee18) ?? num(slot.cartRate);
    const holes = num(slot.holes) ?? query.holes;
    const courseName = typeof slot.courseName === "string" ? slot.courseName : undefined;
    out.push({ date: when.date, time: when.time, openSpots: num(spots), price, holes, bookingUrl, courseName });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export class CpsProvider implements Provider {
  readonly name = "cps";
  private readonly http: HttpClient;
  private readonly base: string;
  private apiKey: string | undefined;
  private websiteId: string | undefined;
  private token: string | null = null;
  private bootstrapped = false;

  constructor(
    private readonly cfg: CpsConfig,
    private readonly ctx: ProviderContext,
  ) {
    this.http = new HttpClient(ctx.fetch, ctx.timeoutMs);
    this.base = `https://${cfg.site}.cps.golf`;
    this.apiKey = cfg.apiKey;
    this.websiteId = cfg.websiteId;
  }

  get bookingUrl(): string {
    return `${this.base}/onlineresweb/search-teetime`;
  }

  /** Try the app's unauthenticated configuration endpoints for the per-site api key. */
  private async bootstrap(): Promise<void> {
    if (this.bootstrapped || this.apiKey) return;
    this.bootstrapped = true;
    const candidates = [
      `${this.base}/onlineres/onlineapi/api/v1/onlinereservation/Configuration`,
      `${this.base}/onlineres/onlineapi/api/v1/Configuration`,
      `${this.base}/onlineresweb/api/v1/Configuration`,
      `${this.base}/onlineresweb/assets/config/config.json`,
    ];
    for (const url of candidates) {
      let text: string;
      try {
        ({ text } = await this.http.text(url, { headers: { Accept: "application/json", "client-id": "onlineresweb" } }));
      } catch {
        continue;
      }
      const key = new RegExp(`(?:apiKey|api_key)["']?\\s*[:=]\\s*["'](${GUID_RE.source})`, "i").exec(text);
      if (key) this.apiKey = key[1];
      const site = new RegExp(`websiteId["']?\\s*[:=]\\s*["'](${GUID_RE.source})`, "i").exec(text);
      if (site && !this.websiteId) this.websiteId = site[1];
      if (this.apiKey) {
        this.ctx.log(`cps ${this.cfg.site}: bootstrapped api key from ${url}`);
        return;
      }
    }
  }

  /** Anonymous bearer token, the way the web app obtains one. */
  private async anonymousToken(): Promise<string | null> {
    if (this.token) return this.token;
    let authEp = `${this.base}/identityapi/connect/authorize`;
    let tokenEp = `${this.base}/identityapi/connect/token`;
    try {
      const disco = await this.http.json<Json>(`${this.base}/identityapi/.well-known/openid-configuration`);
      if (typeof disco.authorization_endpoint === "string") authEp = disco.authorization_endpoint;
      if (typeof disco.token_endpoint === "string") tokenEp = disco.token_endpoint;
    } catch {
      /* fall through with defaults */
    }

    // 1. client_credentials (allowed on some installs)
    try {
      const res = await this.http.request(tokenEp, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: buildQuery({ grant_type: "client_credentials", client_id: "onlinereswebshortlived", scope: "onlinereservation references" }),
      });
      if (res.status === 200) {
        const body = (await res.json()) as Json;
        if (typeof body.access_token === "string") {
          this.token = body.access_token;
          return this.token;
        }
      }
    } catch {
      /* try next */
    }

    // 2. implicit flow: the token rides in the redirect fragment
    for (const redirectUri of [`${this.base}/onlineresweb/`, `${this.base}/onlineresweb/index.html`, `${this.base}/onlineresweb/auth-callback`]) {
      try {
        const url = `${authEp}?${buildQuery({
          client_id: "onlinereswebshortlived",
          response_type: "token",
          scope: "onlinereservation references",
          redirect_uri: redirectUri,
          state: randomUUID().replace(/-/g, ""),
          nonce: randomUUID().replace(/-/g, ""),
        })}`;
        const res = await this.http.request(url, { redirect: "manual" });
        const loc = res.headers.get("location") ?? "";
        const m = /[#&]access_token=([^&]+)/.exec(loc);
        if (m) {
          this.token = decodeURIComponent(m[1]);
          return this.token;
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async headers(requestId: string): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "client-id": "onlineresweb",
      "x-componentid": "1",
      "x-productid": "1",
      "x-moduleid": "7",
      "x-siteid": this.cfg.siteId ?? "1",
      "x-terminalid": "3",
      "x-ismobile": "false",
      "x-timezoneid": this.ctx.timezone,
      "x-requestid": requestId,
      Referer: this.bookingUrl,
      Origin: this.base,
    };
    if (this.apiKey) h["x-apikey"] = this.apiKey;
    if (this.websiteId) h["x-websiteid"] = this.websiteId;
    const token = await this.anonymousToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async registerTransaction(tid: string): Promise<boolean> {
    const res = await this.http.request(`${this.base}/onlineres/onlineapi/api/v1/onlinereservation/RegisterTransactionId`, {
      method: "POST",
      headers: { ...(await this.headers(tid)), "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: tid }),
    });
    const text = await res.text();
    return res.status < 400 && text.trim().toLowerCase().includes("true");
  }

  async fetchDay(query: FetchQuery): Promise<FetchResult> {
    try {
      await this.bootstrap();

      let tid = randomUUID();
      let registered = false;
      for (let attempt = 0; attempt < 2 && !registered; attempt++) {
        tid = randomUUID();
        registered = await this.registerTransaction(tid);
      }

      const url = `${this.base}/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes?${buildQuery({
        searchDate: toJsDateString(query.date),
        holes: query.holes,
        numberOfPlayer: 0,
        courseIds: this.cfg.courseIds ?? "1",
        searchTimeType: 0,
        transactionId: tid,
        teeOffTimeMin: 0,
        teeOffTimeMax: 23,
        isChangeTeeOffTime: "true",
        teeSheetSearchView: 5,
        classCode: this.cfg.classCode ?? "R",
        defaultOnlineRate: "N",
        isUseCapacityPricing: "false",
        memberStoreId: this.cfg.memberStoreId ?? "1",
        searchType: 1,
      })}`;
      const res = await this.http.request(url, { headers: await this.headers(tid) });
      const text = await res.text();

      if (res.status === 403) {
        return { status: "error", provider: this.name, times: [], message: `${this.cfg.site}.cps.golf blocked the request (Cloudflare 403). Check availability on the booking site.` };
      }
      if (res.status === 401) {
        return { status: "error", provider: this.name, times: [], message: `${this.cfg.site}.cps.golf requires a session token this app could not obtain (401). Check availability on the booking site.` };
      }
      if (res.status >= 400) {
        return { status: "error", provider: this.name, times: [], message: `CPS HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}` };
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return { status: "error", provider: this.name, times: [], message: `CPS returned non-JSON: ${text.slice(0, 120).replace(/\s+/g, " ")}` };
      }
      const slots = extractCpsSlots(data);
      const times = parseCpsSlots(data, query, this.ctx.timezone, this.bookingUrl);
      if (slots.length && !times.length) {
        return { status: "error", provider: this.name, times: [], message: `CPS returned ${slots.length} slots but none parsed; first: ${JSON.stringify(slots[0]).slice(0, 200)}` };
      }
      return { status: "ok", provider: this.name, times };
    } catch (err) {
      return { status: "error", provider: this.name, times: [], message: `CPS request failed: ${(err as Error).message}` };
    }
  }
}
