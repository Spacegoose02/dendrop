/**
 * Counts failed sign-ins so passwords can't be guessed quickly. Each key (a username, or an IP
 * address) gets `max` failures in a sliding `windowMs`; after that it's locked until the oldest
 * failure falls out of the window. A successful sign-in clears the username's count.
 *
 * Kept in memory: a restart forgets the counts, which is fine for slowing guessing down.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const since = this.clock() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Milliseconds until `key` may try again, or 0 if it may now. */
  waitMs(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(0, list[list.length - this.max]! + this.windowMs - this.clock());
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.clock());
    this.failures.set(key, list);
    // Keep memory bounded if someone sprays many usernames.
    if (this.failures.size > 50_000) for (const k of [...this.failures.keys()].slice(0, 10_000)) this.failures.delete(k);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}
