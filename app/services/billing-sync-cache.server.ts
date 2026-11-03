/**
 * Remembers when a shop's Shopify billing status was last checked, so the app
 * does not ask Shopify on every page load.
 *
 * Why this exists: `requireAppContext()` used to call Shopify's GraphQL API for
 * the active subscription on every loader. That call sits on the critical path
 * of every navigation (a round trip of one to two seconds is normal) and the
 * layout loader and the page loader both made it. Billing changes rarely, and
 * the billing page itself always re-checks, so the result is trusted for a few
 * minutes instead.
 *
 * Behaviour, per shop key:
 *  - a successful check is trusted for `ttlMs`;
 *  - a failed check is not retried for `retryMs`, so an outage does not make
 *    every page wait for a timeout;
 *  - concurrent callers share one in-flight check;
 *  - `force` always checks (used by the billing page);
 *  - `invalidate` forgets the key.
 *
 * State is per process. That is fine: the worst case on a multi-instance
 * deployment is one extra check per instance per TTL window.
 */
export interface BillingSyncCacheOptions {
  /** How long a successful check is trusted. Default 5 minutes. */
  ttlMs?: number;
  /** How long to wait before retrying after a failed check. Default 30 seconds. */
  retryMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface Entry {
  checkedAt: number;
  ok: boolean;
  inflight?: Promise<unknown>;
}

export const DEFAULT_BILLING_SYNC_TTL_MS = 5 * 60_000;
export const DEFAULT_BILLING_SYNC_RETRY_MS = 30_000;

/** Reads a millisecond setting from the environment; anything invalid falls back. */
export function readMsSetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class BillingSyncCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(options: BillingSyncCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_BILLING_SYNC_TTL_MS;
    this.retryMs = options.retryMs ?? DEFAULT_BILLING_SYNC_RETRY_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs `sync` unless a recent check makes it unnecessary, in which case
   * `current` is returned untouched. A rejected `sync` is rethrown to every caller
   * that was waiting on it.
   */
  async run<T>(key: string, sync: () => Promise<T>, current: T, force = false): Promise<T> {
    const entry = this.entries.get(key);
    if (entry?.inflight) return entry.inflight as Promise<T>;

    if (!force && entry) {
      const trustedFor = entry.ok ? this.ttlMs : this.retryMs;
      if (this.now() - entry.checkedAt < trustedFor) return current;
    }

    const inflight = sync().then(
      (value) => {
        this.entries.set(key, { checkedAt: this.now(), ok: true });
        return value;
      },
      (error: unknown) => {
        this.entries.set(key, { checkedAt: this.now(), ok: false });
        throw error;
      },
    );
    this.entries.set(key, { checkedAt: entry?.checkedAt ?? 0, ok: entry?.ok ?? false, inflight });
    return inflight;
  }

  /** Forget a shop so the next call checks again (for example after a plan change). */
  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
