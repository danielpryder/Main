/** In-memory TTL cache with request coalescing (concurrent callers share one in-flight promise). */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((value) => {
        this.entries.set(key, { value, expires: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}
