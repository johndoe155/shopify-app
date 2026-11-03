import { describe, expect, it } from "vitest";
import { BillingSyncCache, readMsSetting } from "~/services/billing-sync-cache.server";

function harness(options: { ttlMs?: number; retryMs?: number } = {}) {
  let clock = 1_000_000;
  const cache = new BillingSyncCache({ ...options, now: () => clock });
  let calls = 0;
  const sync = async () => {
    calls += 1;
    return `synced-${calls}`;
  };
  return {
    cache,
    sync,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("billing sync cache", () => {
  it("checks Shopify the first time and trusts the result afterwards", async () => {
    const h = harness({ ttlMs: 60_000 });
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored")).toBe("synced-1");
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored")).toBe("stored");
    expect(h.calls()).toBe(1);
  });

  it("checks again once the trusted window has passed", async () => {
    const h = harness({ ttlMs: 60_000 });
    await h.cache.run("a.myshopify.com", h.sync, "stored");
    h.advance(59_999);
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored")).toBe("stored");
    h.advance(2);
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored")).toBe("synced-2");
    expect(h.calls()).toBe(2);
  });

  it("keeps shops separate", async () => {
    const h = harness();
    await h.cache.run("a.myshopify.com", h.sync, "stored");
    await h.cache.run("b.myshopify.com", h.sync, "stored");
    expect(h.calls()).toBe(2);
  });

  it("shares one in-flight check between concurrent callers", async () => {
    const h = harness();
    const results = await Promise.all([
      h.cache.run("a.myshopify.com", h.sync, "stored"),
      h.cache.run("a.myshopify.com", h.sync, "stored"),
      h.cache.run("a.myshopify.com", h.sync, "stored"),
    ]);
    expect(results).toEqual(["synced-1", "synced-1", "synced-1"]);
    expect(h.calls()).toBe(1);
  });

  it("force always checks", async () => {
    const h = harness();
    await h.cache.run("a.myshopify.com", h.sync, "stored");
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored", true)).toBe("synced-2");
  });

  it("invalidate makes the next call check again", async () => {
    const h = harness();
    await h.cache.run("a.myshopify.com", h.sync, "stored");
    h.cache.invalidate("a.myshopify.com");
    expect(await h.cache.run("a.myshopify.com", h.sync, "stored")).toBe("synced-2");
  });

  it("backs off after a failure, then retries", async () => {
    const h = harness({ retryMs: 30_000 });
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("timeout");
      return "recovered";
    };
    await expect(h.cache.run("a.myshopify.com", flaky, "stored")).rejects.toThrow("timeout");
    expect(await h.cache.run("a.myshopify.com", flaky, "stored")).toBe("stored");
    expect(attempts).toBe(1);
    h.advance(30_001);
    expect(await h.cache.run("a.myshopify.com", flaky, "stored")).toBe("recovered");
  });

  it("rejects every waiting caller when the shared check fails", async () => {
    const h = harness();
    const failing = async () => {
      throw new Error("boom");
    };
    const settled = await Promise.allSettled([
      h.cache.run("a.myshopify.com", failing, "stored"),
      h.cache.run("a.myshopify.com", failing, "stored"),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("readMsSetting", () => {
  it("uses the fallback for missing, empty or invalid values", () => {
    expect(readMsSetting(undefined, 5)).toBe(5);
    expect(readMsSetting("", 5)).toBe(5);
    expect(readMsSetting("abc", 5)).toBe(5);
    expect(readMsSetting("-1", 5)).toBe(5);
  });

  it("accepts zero (always check) and positive numbers", () => {
    expect(readMsSetting("0", 5)).toBe(0);
    expect(readMsSetting("120000", 5)).toBe(120000);
  });
});
