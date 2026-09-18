import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, CourseConfig } from "../providers/types.js";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Loads config/courses.json and, if present, config/courses.local.json.
 * The local file is a partial override keyed by course id (handy for pinning
 * discovered provider ids or api keys without editing the tracked file).
 */
export function loadConfig(root: string = ROOT): AppConfig {
  const base = JSON.parse(readFileSync(resolve(root, "config/courses.json"), "utf8")) as AppConfig;
  const localPath = resolve(root, "config/courses.local.json");
  if (!existsSync(localPath)) return validate(base);
  const local = JSON.parse(readFileSync(localPath, "utf8")) as Partial<AppConfig> & { courses?: Array<Partial<CourseConfig> & { id: string }> };
  const merged: AppConfig = { ...base, ...(local.timezone ? { timezone: local.timezone } : {}) };
  merged.courses = base.courses.map((c) => {
    const override = local.courses?.find((o) => o.id === c.id);
    return override ? { ...c, ...override } : c;
  });
  return validate(merged);
}

function validate(cfg: AppConfig): AppConfig {
  if (!cfg.timezone) throw new Error("config: timezone missing");
  const ids = new Set<string>();
  for (const c of cfg.courses) {
    if (!c.id || ids.has(c.id)) throw new Error(`config: duplicate or missing course id ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.providers) || !c.providers.length) throw new Error(`config: course ${c.id} has no providers`);
  }
  return cfg;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
