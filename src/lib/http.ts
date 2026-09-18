/** Small fetch wrapper: timeout, default browser-like headers, and a per-instance cookie jar. */

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Follow redirects (default true). When false, 3xx responses are returned as-is. */
  redirect?: "follow" | "manual";
  timeoutMs?: number;
}

export class HttpClient {
  private cookies = new Map<string, string>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  private absorbCookies(res: Response): void {
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    const list = anyHeaders.getSetCookie ? anyHeaders.getSetCookie() : [];
    for (const raw of list) {
      const first = raw.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  async request(url: string, opts: HttpOptions = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-CA,en;q=0.9",
        ...opts.headers,
      };
      const cookie = this.cookieHeader();
      if (cookie && !headers.Cookie) headers.Cookie = cookie;
      const res = await this.fetchImpl(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        redirect: opts.redirect ?? "follow",
        signal: controller.signal,
      });
      this.absorbCookies(res);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async text(url: string, opts: HttpOptions = {}): Promise<{ res: Response; text: string }> {
    const res = await this.request(url, opts);
    const text = await res.text();
    if (res.status >= 400) throw new HttpError(res.status, url, text);
    return { res, text };
  }

  async json<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
    const { text } = await this.text(url, { ...opts, headers: { Accept: "application/json, text/plain, */*", ...opts.headers } });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 150).replace(/\s+/g, " ")}`);
    }
  }
}

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}
