/**
 * Offline stand-in for global fetch that answers the booking-platform URLs with
 * the fixtures under test/fixtures. Used by the test suite and by
 * `MOCK_PROVIDERS=1 npm run dev` to demo the UI without hitting real sites.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIX = resolve(import.meta.dirname, "../../test/fixtures");
const read = (name: string) => readFileSync(resolve(FIX, name), "utf8");

/** Rewrites fixture dates (2026-09-26) to the requested date so any day shows data. */
function retarget(body: string, from: string, to: string): string {
  return body.split(from).join(to);
}

export function createMockFetch(opts: { log?: (url: string) => void } = {}): typeof fetch {
  const respond = (body: string, init: ResponseInit = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    opts.log?.(`${init?.method ?? "GET"} ${url}`);

    // ---- Chronogolf ----
    if (u.hostname === "www.chronogolf.com") {
      if (u.pathname.startsWith("/club/")) {
        // Northview has two 18-hole courses; give it a club page whose __NEXT_DATA__ lacks UUIDs
        // so the classic path is exercised.
        if (u.pathname.includes("northview")) {
          return respond(`<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"club":{"id":2222,"slug":"northview-golf-country-club","courses":[]}}}}</script></html>`, { headers: { "content-type": "text/html" } });
        }
        return respond(read("chronogolf-club.html"), { headers: { "content-type": "text/html" } });
      }
      if (u.pathname === "/marketplace/v2/teetimes") {
        const page = Number(u.searchParams.get("page") ?? "1");
        if (page > 1) return respond("[]");
        return respond(retarget(read("chronogolf-v2.json"), "2026-09-26", u.searchParams.get("start_date") ?? "2026-09-26"));
      }
      if (/\/marketplace\/clubs\/\d+\/courses$/.test(u.pathname)) return respond(read("chronogolf-classic-courses.json"));
      if (/\/marketplace\/organizations\/\d+\/affiliation_types$/.test(u.pathname)) return respond(read("chronogolf-classic-affiliations.json"));
      if (/\/marketplace\/clubs\/\d+\/teetimes$/.test(u.pathname)) {
        const aff = u.searchParams.getAll("affiliation_type_ids[]");
        // Only the "Public" player type (502) sells online; others return an empty sheet.
        if (aff[0] !== "502") return respond("[]");
        const body = retarget(read("chronogolf-classic-teetimes.json"), "2026-09-26", u.searchParams.get("date") ?? "2026-09-26");
        // Canal course: shift times by 10 minutes so the two courses differ.
        return respond(u.searchParams.get("course_id") === "22909" ? body.replace(/"start_time":"0(\d):(\d)0"/g, (_m, h, t) => `"start_time":"0${h}:${t}5"`) : body);
      }
    }

    // ---- CPS v4 ----
    if (u.hostname.endsWith(".cps.golf") && u.hostname !== "w.cps.golf") {
      if (u.pathname.endsWith("/RegisterTransactionId")) return respond("true");
      if (u.pathname.endsWith("/TeeTimes")) {
        const jsDate = u.searchParams.get("searchDate") ?? "";
        const m = /(\w{3}) (\w{3}) (\d{2}) (\d{4})/.exec(jsDate);
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const isoDate = m ? `${m[4]}-${String(months.indexOf(m[2]) + 1).padStart(2, "0")}-${m[3]}` : "2026-09-26";
        // Morgan Creek's CPS site plays the "strict Cloudflare" role so the Chronogolf fallback runs.
        if (u.hostname.startsWith("morgancreekbc")) return respond("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } });
        return respond(retarget(read("cps-teetimes.json"), "2026-09-26", isoDate));
      }
      if (u.pathname.includes("/identityapi/connect/token")) return respond(JSON.stringify({ access_token: "anon-token" }));
      return respond("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }

    // ---- CPS v3 (Kings Links) ----
    if (u.hostname === "w.cps.golf") {
      if (!u.pathname.includes("(S(")) {
        // First hit mints a session and redirects (query string dropped), like the real site.
        return new Response(read("cps-v3.html"), { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(read("cps-v3.html"), { status: 200, headers: { "content-type": "text/html" } });
    }

    return respond("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
}
