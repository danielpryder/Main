import express from "express";
import { resolve } from "node:path";
import { envInt, loadConfig } from "./config/load.js";
import { createMockFetch } from "./lib/mockFetch.js";
import { AvailabilityService, ValidationError } from "./services/availability.js";

const config = loadConfig();
const mock = process.env.MOCK_PROVIDERS === "1";
const service = new AvailabilityService(config, {
  timeoutMs: envInt("PROVIDER_TIMEOUT_MS", 15_000),
  cacheTtlMs: envInt("CACHE_TTL_SECONDS", 120) * 1000,
  fetch: mock ? createMockFetch() : fetch,
  log: (msg) => console.log(`[provider] ${msg}`),
});
if (mock) console.log("MOCK_PROVIDERS=1: serving fixture data instead of calling the booking sites");

const app = express();
app.disable("x-powered-by");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timezone: config.timezone, courses: config.courses.length });
});

app.get("/api/courses", (_req, res) => {
  res.json({
    timezone: config.timezone,
    courses: config.courses.map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city,
      bookingUrl: c.bookingUrl,
      bookingWindowDays: c.bookingWindowDays,
      notes: c.notes,
      live: c.providers.some((p) => p.type !== "linkout"),
    })),
  });
});

app.get("/api/availability", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  try {
    const result = await service.check({
      date: q.date ?? "",
      time: q.time || undefined,
      players: Number(q.players ?? 2),
      windowMinutes: q.window !== undefined ? Number(q.window) : undefined,
      holes: q.holes !== undefined ? Number(q.holes) : undefined,
      courseIds: q.courses ? q.courses.split(",").filter(Boolean) : undefined,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: "internal error" });
    }
  }
});

app.use(express.static(resolve(import.meta.dirname, "../public")));

const port = envInt("PORT", 3000);
app.listen(port, () => {
  console.log(`Tee time checker listening on http://localhost:${port}  (timezone ${config.timezone})`);
});
