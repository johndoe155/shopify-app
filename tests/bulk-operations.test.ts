/**
 * One bulk operation per shop, ever (spike 2, resolved in code).
 *
 * The reported failure: "Every products/update webhook starts a full-catalogue
 * bulk operation and republishes everything. Shopify allows one bulk operation
 * per shop at a time... A bulk price edit of 200 products would cause a pile of
 * retries and failures."
 *
 * These tests drive the real `ShopifyCatalogSource` against a fake Admin API that
 * enforces Shopify's single-operation rule and counts how many bulk operations
 * were actually started.
 */
import { describe, expect, it } from "vitest";
import { ShopifyCatalogSource, parseProductJsonl } from "~/services/catalog.server";
import { BulkOperationCoordinator, isAlreadyRunningError } from "~/services/bulk-operations.server";

/** A fake Admin API that behaves like Shopify's bulk-operation endpoints. */
class FakeAdmin {
  public started = 0;
  public polled = 0;
  public deletedCalls = 0;
  private status: "NONE" | "RUNNING" | "COMPLETED" = "NONE";
  private id = "gid://shopify/BulkOperation/1";
  private readonly jsonl: string;

  constructor(
    private readonly options: {
      /** Every completed operation must be polled this many times first. */
      pollsBeforeCompletion?: number;
      /** Refuse `bulkOperationRunQuery` while another operation is RUNNING. */
      enforceSingleOperation?: boolean;
      /** Report an operation as already running on the first read. */
      adoptOnFirstRead?: boolean;
    } = {},
  ) {
    this.jsonl = [
      JSON.stringify({
        id: "gid://shopify/Product/1",
        handle: "amla-hair-oil",
        title: "Amla hair oil",
        vendor: "Aranya Naturals",
        productType: "Beauty",
        status: "ACTIVE",
      }),
      JSON.stringify({ id: "gid://shopify/ProductVariant/11", __parentId: "gid://shopify/Product/1", title: "Default", price: "249.00", compareAtPrice: "399.00" }),
      JSON.stringify({ id: "gid://shopify/Product/2", handle: "neem-soap", title: "Neem soap", status: "ACTIVE" }),
      JSON.stringify({ id: "gid://shopify/ProductVariant/21", __parentId: "gid://shopify/Product/2", title: "Default", price: "99.00", compareAtPrice: null }),
    ].join("\n");
    if (options.adoptOnFirstRead) {
      this.status = "RUNNING";
      this.id = "gid://shopify/BulkOperation/adopted";
    }
  }

  private polls = 0;

  graphql = async (query: string): Promise<Response> => {
    if (query.includes("currentBulkOperation")) {
      this.polled += 1;
      if (this.status === "NONE") return Response.json({ data: { currentBulkOperation: null } });
      if (this.status === "RUNNING") {
        this.polls += 1;
        if (this.polls >= (this.options.pollsBeforeCompletion ?? 1)) {
          this.status = "COMPLETED";
          return Response.json({
            data: {
              currentBulkOperation: {
                id: this.id,
                status: "COMPLETED",
                url: "https://example.invalid/bulk.jsonl",
                errorCode: null,
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                objectCount: "4",
              },
            },
          });
        }
        return Response.json({
          data: {
            currentBulkOperation: {
              id: this.id,
              status: "RUNNING",
              url: null,
              errorCode: null,
              createdAt: new Date().toISOString(),
              completedAt: null,
              objectCount: null,
            },
          },
        });
      }
      return Response.json({
        data: {
          currentBulkOperation: {
            id: this.id,
            status: "COMPLETED",
            url: "https://example.invalid/bulk.jsonl",
            errorCode: null,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            objectCount: "4",
          },
        },
      });
    }
    if (query.includes("bulkOperationRunQuery")) {
      if (this.options.enforceSingleOperation && this.status === "RUNNING") {
        return Response.json({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: null,
              userErrors: [{ field: null, message: "A bulk query operation for this app and shop is already in progress" }],
            },
          },
        });
      }
      this.started += 1;
      this.status = "RUNNING";
      this.polls = 0;
      this.id = `gid://shopify/BulkOperation/${this.started + 1}`;
      return Response.json({ data: { bulkOperationRunQuery: { bulkOperation: { id: this.id, status: "RUNNING" }, userErrors: [] } } });
    }
    if (query.includes("nodes(ids:")) {
      return Response.json({ data: { nodes: [] } });
    }
    return Response.json({ data: {} });
  };
}

function installFetch(jsonl: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(jsonl, { status: 200 })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const sleep = async () => {};

describe("bulk operation coordination", () => {
  it("coalesces concurrent catalogue reads into one bulk operation", async () => {
    const admin = new FakeAdmin({ pollsBeforeCompletion: 2, enforceSingleOperation: true });
    const restore = installFetch(
      [
        JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" }),
      ].join("\n"),
    );
    try {
      const catalog = new ShopifyCatalogSource(admin, { sleep, pollIntervalMs: 10 });
      // Ten webhooks (or ten admin requests) asking for the catalogue at once.
      const reads = await Promise.all(Array.from({ length: 10 }, () => catalog.fetchProducts()));
      expect(admin.started).toBe(1);
      expect(reads.every((products) => products.length === 1)).toBe(true);
    } finally {
      restore();
    }
  });

  it("serves a second read from the cache instead of starting another operation", async () => {
    const admin = new FakeAdmin({ enforceSingleOperation: true });
    const restore = installFetch(
      [JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" })].join("\n"),
    );
    try {
      const catalog = new ShopifyCatalogSource(admin, { sleep, pollIntervalMs: 10, cacheTtlMs: 60_000 });
      await catalog.fetchProducts();
      await catalog.fetchProducts();
      await catalog.fetchProducts();
      // Three reads, one bulk operation: the published catalogue is still
      // current, so `currentBulkOperation` is reused instead of running another.
      expect(admin.started).toBe(1);
      await catalog.fetchProducts({ force: true });
      expect(admin.started).toBe(2);
    } finally {
      restore();
    }
  });

  it("adopts a bulk operation another instance already started instead of failing", async () => {
    const admin = new FakeAdmin({ adoptOnFirstRead: true, enforceSingleOperation: true });
    const restore = installFetch(
      [JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" })].join("\n"),
    );
    try {
      const catalog = new ShopifyCatalogSource(admin, { sleep, pollIntervalMs: 10 });
      const products = await catalog.fetchProducts();
      expect(products).toHaveLength(1);
      expect(admin.started).toBe(0); // it never started its own
    } finally {
      restore();
    }
  });

  it("adopts the running operation when the start call loses a race", async () => {
    // `currentBulkOperation` reports nothing, but `bulkOperationRunQuery` says one
    // is already in progress: the read/write window another instance slipped into.
    const admin = new FakeAdmin({ enforceSingleOperation: true });
    let reads = 0;
    const racingAdmin = {
      graphql: async (query: string) => {
        if (query.includes("currentBulkOperation")) {
          reads += 1;
          // First read: nothing running. After that: the adopted operation.
          if (reads === 1) return Response.json({ data: { currentBulkOperation: null } });
          return Response.json({
            data: {
              currentBulkOperation: {
                id: "gid://shopify/BulkOperation/other",
                status: "COMPLETED",
                url: "https://example.invalid/bulk.jsonl",
                errorCode: null,
                createdAt: null,
                completedAt: null,
                objectCount: "1",
              },
            },
          });
        }
        if (query.includes("bulkOperationRunQuery")) {
          return Response.json({
            data: {
              bulkOperationRunQuery: {
                bulkOperation: null,
                userErrors: [{ message: "A bulk query operation for this app and shop is already in progress" }],
              },
            },
          });
        }
        return admin.graphql(query);
      },
    };
    const restore = installFetch(
      [JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" })].join("\n"),
    );
    try {
      const catalog = new ShopifyCatalogSource(racingAdmin, { sleep, pollIntervalMs: 10 });
      const products = await catalog.fetchProducts();
      expect(products).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("recognises Shopify's already-running message", () => {
    expect(isAlreadyRunningError("A bulk query operation for this app and shop is already in progress")).toBe(true);
    expect(isAlreadyRunningError("Another bulk operation is running for this shop")).toBe(true);
    expect(isAlreadyRunningError("Access denied for products field")).toBe(false);
  });

  it("times out a bulk operation that never finishes", async () => {
    const poll = async () =>
      Response.json({
        data: {
          currentBulkOperation: {
            id: "op-never",
            status: "RUNNING",
            url: null,
            errorCode: null,
            createdAt: null,
            completedAt: null,
            objectCount: null,
          },
        },
      });
    const admin = {
      graphql: async (query: string) =>
        query.includes("bulkOperationRunQuery")
          ? Response.json({
              data: { bulkOperationRunQuery: { bulkOperation: { id: "op-never" }, userErrors: [] } },
            })
          : poll(),
    };
    const coordinator = new BulkOperationCoordinator(admin, parseProductJsonl, "{ products { edges { node { id } } } }", {
      sleep,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    await expect(coordinator.load()).rejects.toThrow(/Timed out/);
  });

  it("follows a newer operation for the shop instead of failing", async () => {
    let reads = 0;
    const admin = {
      graphql: async (query: string) => {
        if (query.includes("bulkOperationRunQuery")) {
          return Response.json({ data: { bulkOperationRunQuery: { bulkOperation: { id: "op-1", status: "RUNNING" }, userErrors: [] } } });
        }
        if (query.includes("currentBulkOperation")) {
          reads += 1;
          // The first poll finds the operation we started; every later poll finds
          // a different one (another instance started it after ours finished).
          const id = reads === 1 ? "op-1" : "op-2";
          if (reads === 1) {
            return Response.json({ data: { currentBulkOperation: { id, status: "RUNNING", url: null, errorCode: null, createdAt: null, completedAt: null, objectCount: null } } });
          }
          return Response.json({
            data: {
              currentBulkOperation: { id, status: "COMPLETED", url: "https://example.invalid/bulk.jsonl", errorCode: null, createdAt: null, completedAt: null, objectCount: "1" },
            },
          });
        }
        return Response.json({ data: {} });
      },
    };
    const restore = installFetch(
      [JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" })].join("\n"),
    );
    try {
      const coordinator = new BulkOperationCoordinator(admin, parseProductJsonl, "{ products { edges { node { id } } } }", {
        sleep,
        pollIntervalMs: 1,
      });
      const read = await coordinator.load();
      expect(read.products).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("counts how often a caller joined an in-flight read", async () => {
    const admin = new FakeAdmin({ pollsBeforeCompletion: 3 });
    const restore = installFetch(
      [JSON.stringify({ id: "gid://shopify/Product/1", handle: "a", title: "A", status: "ACTIVE" })].join("\n"),
    );
    try {
      const joins: Array<{ inFlight: boolean }> = [];
      const catalog = new ShopifyCatalogSource(
        { graphql: (query: string) => admin.graphql(query) },
        { sleep, pollIntervalMs: 10, cacheTtlMs: 0 },
      );
      void catalog;
      const coordinator = new BulkOperationCoordinator(
        admin,
        parseProductJsonl,
        "{ products { edges { node { id } } } }",
        { sleep, pollIntervalMs: 10, cacheTtlMs: 0, onCoalesce: (info) => joins.push(info) },
      );
      await Promise.all([coordinator.load(), coordinator.load(), coordinator.load()]);
      expect(admin.started).toBe(1);
      expect(joins.length).toBe(2);
    } finally {
      restore();
    }
  });

  it("looks a single product up without a bulk operation", async () => {
    let bulkCalls = 0;
    const admin = {
      graphql: async (query: string) => {
        if (query.includes("bulkOperationRunQuery")) bulkCalls += 1;
        if (query.includes("query ProductForScan")) {
          return Response.json({
            data: {
              product: {
                id: "gid://shopify/Product/1",
                handle: "a",
                title: "A",
                vendor: null,
                productType: null,
                status: "ACTIVE",
                variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/11", title: "Default", price: "249.0", compareAtPrice: null } }] },
                metafields: { edges: [] },
              },
            },
          });
        }
        return Response.json({ data: {} });
      },
    };
    const catalog = new ShopifyCatalogSource(admin, { sleep });
    const product = await catalog.fetchProduct("gid://shopify/Product/1");
    expect(product?.variants[0]!.price).toBe(249);
    expect(bulkCalls).toBe(0);
  });
});
