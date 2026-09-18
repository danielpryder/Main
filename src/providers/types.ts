/** One bookable tee time, normalized across booking platforms. */
export interface TeeTime {
  /** Local course date, YYYY-MM-DD */
  date: string;
  /** Local course time, HH:MM (24h) */
  time: string;
  /** Open spots in the group, or null when the platform does not say */
  openSpots: number | null;
  /** Per-player green fee in CAD, or null when unknown */
  price: number | null;
  holes: number;
  /** Deep link to book this exact slot when the platform supports it */
  bookingUrl?: string;
  /** Sub-course name for multi-course clubs (e.g. Northview Ridge / Canal) */
  courseName?: string;
}

export type FetchStatus = "ok" | "manual" | "error";

export interface FetchResult {
  status: FetchStatus;
  /** Provider that produced the result */
  provider: string;
  times: TeeTime[];
  /** Human readable explanation for manual / error results */
  message?: string;
}

export interface FetchQuery {
  /** YYYY-MM-DD in course-local time */
  date: string;
  /** Number of players, 1-4 */
  players: number;
  holes: number;
}

export interface Provider {
  readonly name: string;
  fetchDay(query: FetchQuery): Promise<FetchResult>;
}

export interface ProviderContext {
  timezone: string;
  timeoutMs: number;
  fetch: typeof fetch;
  log: (msg: string) => void;
}

/* ---- provider config shapes (mirrors config/courses.json) ---- */

export interface ChronogolfConfig {
  type: "chronogolf";
  slug: string;
  /** Pin to skip discovery of the modern (v2) API's course UUIDs */
  courseUuids?: string[];
  /** Classic marketplace API ids; used when set and v2 discovery fails */
  clubId?: number | string;
  courseId?: number | string;
  affiliationTypeId?: number | string;
}

export interface CpsConfig {
  type: "cps";
  site: string;
  courseIds?: string;
  classCode?: string;
  memberStoreId?: string;
  siteId?: string;
  apiKey?: string;
  websiteId?: string;
}

export interface CpsV3Config {
  type: "cps_v3";
  baseUrl: string;
  courseId?: string;
}

export interface LinkoutConfig {
  type: "linkout";
  reason?: string;
}

export type ProviderConfig = ChronogolfConfig | CpsConfig | CpsV3Config | LinkoutConfig;

export interface CourseConfig {
  id: string;
  name: string;
  city: string;
  bookingUrl: string;
  bookingWindowDays: number | null;
  notes?: string;
  providers: ProviderConfig[];
}

export interface AppConfig {
  timezone: string;
  courses: CourseConfig[];
}
