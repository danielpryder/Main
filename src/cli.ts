/**
 * CLI: npm run check -- --date 2026-09-26 --time 09:00 --players 2 [--window 90] [--holes 18] [--courses fraserview,northlands] [--json]
 */
import { envInt, loadConfig } from "./config/load.js";
import { AvailabilityService, ValidationError, type CourseAvailability } from "./services/availability.js";
import { addDays, todayIn } from "./lib/time.js";
import { createMockFetch } from "./lib/mockFetch.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fmtDelta(d: number | null): string {
  if (d === null) return "";
  if (d === 0) return "on time";
  return `${d > 0 ? "+" : "-"}${Math.abs(d)}m`;
}

function printCourse(c: CourseAvailability, players: number): void {
  const head = `${c.course.name} (${c.course.city})`;
  console.log(`\n${head}\n${"-".repeat(head.length)}`);
  if (c.beyondWindow) console.log(`  Public booking for this date opens ${c.bookingOpens} (${c.course.bookingWindowDays}-day window).`);
  if (c.status === "manual") {
    console.log(`  Check manually: ${c.course.bookingUrl}\n  ${c.message ?? ""}`);
    return;
  }
  if (c.status === "error") {
    console.log(`  Could not fetch: ${c.message}\n  Booking site: ${c.course.bookingUrl}`);
    return;
  }
  if (!c.times.length) {
    console.log(`  No times for ${players} player${players > 1 ? "s" : ""} in the window (${c.totalThatDay} bookable times that day overall).`);
    return;
  }
  for (const t of c.times) {
    const bits = [t.time, t.courseName ? `[${t.courseName}]` : "", fmtDelta(t.deltaMinutes), t.openSpots !== null ? `${t.openSpots} open` : "spots n/a", t.price !== null ? `$${t.price.toFixed(2)}/player` : ""].filter(Boolean);
    console.log(`  ${bits.join("  ")}`);
  }
  console.log(`  Book: ${c.times[0].bookingUrl ?? c.course.bookingUrl}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (args.help) {
    console.log("Usage: npm run check -- --date YYYY-MM-DD [--time HH:MM] [--players 1-4] [--window MINUTES] [--holes 18|9] [--courses id,id] [--json]");
    console.log(`Courses: ${config.courses.map((c) => c.id).join(", ")}`);
    return;
  }
  const service = new AvailabilityService(config, {
    timeoutMs: envInt("PROVIDER_TIMEOUT_MS", 15_000),
    fetch: process.env.MOCK_PROVIDERS === "1" ? createMockFetch() : fetch,
    log: args.json ? () => {} : (m) => console.error(`[provider] ${m}`),
  });
  const date = typeof args.date === "string" ? args.date : addDays(todayIn(config.timezone), 1);
  try {
    const result = await service.check({
      date,
      time: typeof args.time === "string" ? args.time : undefined,
      players: typeof args.players === "string" ? Number(args.players) : 2,
      windowMinutes: typeof args.window === "string" ? Number(args.window) : undefined,
      holes: typeof args.holes === "string" ? Number(args.holes) : undefined,
      courseIds: typeof args.courses === "string" ? args.courses.split(",") : undefined,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const r = result.request;
    console.log(`Tee times on ${r.date}${r.time ? ` around ${r.time} (${r.from}-${r.to})` : ""} for ${r.players} player${r.players > 1 ? "s" : ""}, ${r.holes} holes`);
    for (const c of result.courses) printCourse(c, r.players);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main();
