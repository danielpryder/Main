/**
 * Discovers the platform ids each live course needs and prints a snippet you can paste
 * into config/courses.local.json to pin them (skips discovery on every start).
 *
 *   npm run discover            # all courses
 *   npm run discover -- fraserview northview
 */
import { loadConfig } from "../src/config/load.js";
import { ChronogolfProvider } from "../src/providers/chronogolf.js";
import { CpsProvider } from "../src/providers/cps.js";
import { addDays, todayIn } from "../src/lib/time.js";
import type { ProviderContext } from "../src/providers/types.js";

const config = loadConfig();
const only = process.argv.slice(2);
const ctx: ProviderContext = { timezone: config.timezone, timeoutMs: 20_000, fetch, log: (m) => console.error(`  ${m}`) };
const date = addDays(todayIn(config.timezone), 1);
const pins: Array<Record<string, unknown>> = [];

for (const course of config.courses) {
  if (only.length && !only.includes(course.id)) continue;
  for (const p of course.providers) {
    if (p.type === "chronogolf") {
      console.error(`\n${course.name} — chronogolf slug ${p.slug}`);
      const prov = new ChronogolfProvider(p, ctx);
      try {
        const d = await prov.discover();
        console.error(`  clubId: ${d.clubId ?? "not found"}`);
        for (const c of d.courses) console.error(`  course ${c.uuid}  ${c.name}  (${c.holes} holes)`);
        const r = await prov.fetchDay({ date, players: 2, holes: 18 });
        console.error(`  test fetch for ${date}: ${r.status}${r.message ? ` — ${r.message}` : ""}, ${r.times.length} bookable times`);
        const pin: Record<string, unknown> = { id: course.id, providers: [{ ...p }] };
        const cfg = (pin.providers as Array<Record<string, unknown>>)[0];
        const eighteen = d.courses.filter((c) => c.holes === 18).map((c) => c.uuid);
        if (eighteen.length) cfg.courseUuids = eighteen;
        if (d.clubId) cfg.clubId = d.clubId;
        pins.push(pin);
      } catch (err) {
        console.error(`  discovery failed: ${(err as Error).message}`);
      }
    } else if (p.type === "cps") {
      console.error(`\n${course.name} — cps site ${p.site}`);
      const prov = new CpsProvider(p, ctx);
      const r = await prov.fetchDay({ date, players: 2, holes: 18 });
      console.error(`  test fetch for ${date}: ${r.status}${r.message ? ` — ${r.message}` : ""}, ${r.times.length} bookable times`);
      if (r.status !== "ok") {
        console.error("  If this site needs an api key / website id, capture them from the browser's Network tab");
        console.error("  (headers x-apikey and x-websiteid on the TeeTimes request) and pin them as apiKey / websiteId.");
      }
    } else {
      console.error(`\n${course.name} — ${p.type}: nothing to discover`);
    }
  }
}

if (pins.length) {
  console.error("\nPaste into config/courses.local.json:");
  console.log(JSON.stringify({ courses: pins }, null, 2));
}
