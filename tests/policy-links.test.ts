/**
 * R9 policy-link fetching (audit item L11).
 *
 * The URLs are typed by the merchant, so the fetcher treats them as hostile.
 * These tests pin the SSRF guards and the resource caps rather than the happy
 * path: a link check that can be pointed at the cloud metadata address is worse
 * than no link check at all.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  checkPolicyLinks,
  checkUrlSafety,
  checkUrlShape,
  fetchPage,
  isBlockedAddress,
  resolvePolicyUrl,
} from "~/services/policy-links.server";
import { makeShop } from "./helpers";

/** A lookup that resolves one hostname to whatever the test says it resolves to. */
function lookupTo(addresses: string[] | Error) {
  return async () => {
    if (addresses instanceof Error) throw addresses;
    return addresses.map((address) => ({ address }));
  };
}

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe("resolvePolicyUrl", () => {
  it("expands a relative storefront path", () => {
    expect(resolvePolicyUrl("/policies/refund-policy", "shop.myshopify.com")).toBe(
      "https://shop.myshopify.com/policies/refund-policy",
    );
    expect(resolvePolicyUrl("policies/refund-policy", "shop.myshopify.com")).toBe(
      "https://shop.myshopify.com/policies/refund-policy",
    );
  });

  it("leaves an absolute URL alone", () => {
    const url = "https://example.org/policies/refund";
    expect(resolvePolicyUrl(url, "shop.myshopify.com")).toBe(url);
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "2002:a9fe:a9fe::1", // 6to4 encoding of 169.254.169.254
  ];
  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "2400:cb00::1"];
  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }

  it("does not decide about a hostname, which has to be resolved first", () => {
    expect(isBlockedAddress("shop.myshopify.com")).toBe(false);
  });
});

describe("checkUrlShape", () => {
  it("refuses anything that is not https", () => {
    for (const url of [
      "http://example.org/policy",
      "file:///etc/passwd",
      "ftp://example.org/policy",
      "gopher://example.org/",
      "data:text/html,<h1>hi</h1>",
      "not a url",
    ]) {
      const safety = checkUrlShape(url);
      expect(safety.ok, url).toBe(false);
      expect(safety.reason).toBeTruthy();
    }
  });

  it("refuses credentials in the URL", () => {
    expect(checkUrlShape("https://user:pass@example.org/policy").ok).toBe(false);
  });

  it("refuses internal hostnames", () => {
    for (const host of ["localhost", "metadata.google.internal", "nas.local", "db.internal"]) {
      expect(checkUrlShape(`https://${host}/policy`).ok, host).toBe(false);
    }
  });

  it("accepts an ordinary public https URL", () => {
    expect(checkUrlShape("https://example.org/policies/refund").ok).toBe(true);
  });
});

describe("checkUrlSafety", () => {
  it("resolves the hostname and refuses a private address it points at", async () => {
    // The classic bypass: the literal is a name, the name is 127.0.0.1.
    const safety = await checkUrlSafety("https://internal.example.org/policy", lookupTo(["127.0.0.1"]));
    expect(safety.ok).toBe(false);
    expect(safety.reason).toContain("127.0.0.1");
  });

  it("refuses when any of the resolved addresses is private", async () => {
    const safety = await checkUrlSafety(
      "https://shop.example.org/policy",
      lookupTo(["93.184.216.34", "10.0.0.5"]),
    );
    expect(safety.ok).toBe(false);
    expect(safety.reason).toContain("10.0.0.5");
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const safety = await checkUrlSafety(
      "https://shop.example.org/policy",
      lookupTo(["93.184.216.34", "2606:4700::1111"]),
    );
    expect(safety.ok).toBe(true);
  });

  it("reports a name that does not resolve", async () => {
    const safety = await checkUrlSafety(
      "https://nope.example.org/policy",
      lookupTo(new Error("ENOTFOUND")),
    );
    expect(safety.ok).toBe(false);
    expect(safety.reason).toContain("could not resolve");
  });
});

describe("fetchPage", () => {
  it("refuses a URL that is not https without fetching it", async () => {
    let called = 0;
    const page = await fetchPage(
      "http://169.254.169.254/latest/meta-data",
      (async () => {
        called += 1;
        return response("s3cr3t");
      }) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(called).toBe(0);
    expect(page.status).toBeNull();
    expect(page.error).toContain("only https");
  });

  it("refuses a public name that resolves to a private address", async () => {
    let called = 0;
    const page = await fetchPage(
      "https://internal.example.org/policy",
      (async () => {
        called += 1;
        return response("metadata");
      }) as never,
      1000,
      lookupTo(["169.254.169.254"]),
    );
    expect(called).toBe(0);
    expect(page.error).toContain("refused");
  });

  it("re-validates every redirect hop", async () => {
    // An allowed host must not be able to redirect the checker into the network.
    let called = 0;
    const page = await fetchPage(
      "https://shop.example.org/policy",
      (async () => {
        called += 1;
        if (called === 1) {
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
        }
        return response("should not be reached");
      }) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(called).toBe(1);
    expect(page.status).toBeNull();
    expect(page.error).toContain("only https");
  });

  it("gives up after too many redirects", async () => {
    let called = 0;
    const page = await fetchPage(
      "https://shop.example.org/policy",
      (async () => {
        called += 1;
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(called).toBe(MAX_REDIRECTS + 1);
    expect(page.error).toContain("redirects");
  });

  it("caps the body it reads", async () => {
    const huge = "a".repeat(MAX_BODY_BYTES * 3);
    const page = await fetchPage(
      "https://shop.example.org/policy",
      (async () => response(huge)) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(page.status).toBe(200);
    expect(page.body).not.toBeNull();
    expect(page.body!.length).toBe(MAX_BODY_BYTES);
  });

  it("reports a transport failure rather than throwing", async () => {
    const page = await fetchPage(
      "https://shop.example.org/policy",
      (async () => {
        throw new Error("socket hang up");
      }) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(page.status).toBeNull();
    expect(page.error).toContain("socket hang up");
  });

  it("follows a redirect to another public host", async () => {
    const seen: string[] = [];
    const page = await fetchPage(
      "https://shop.example.org/policy",
      (async (url: string) => {
        seen.push(url);
        if (seen.length === 1) {
          return new Response(null, { status: 301, headers: { location: "https://cdn.example.org/policy" } });
        }
        return response("the refund policy");
      }) as never,
      1000,
      lookupTo(["93.184.216.34"]),
    );
    expect(seen[1]).toBe("https://cdn.example.org/policy");
    expect(page.status).toBe(200);
    expect(page.body).toBe("the refund policy");
  });
});

describe("checkPolicyLinks", () => {
  // Only two keys carry a link; the rest are either text or empty.
  const shop = makeShop({
    refundPolicyUrl: null,
    exchangePolicyUrl: null,
    warrantyPolicyUrl: null,
    paymentModesUrl: null,
    grievanceRedressalUrl: null,
    returnPolicyUrl: "/policies/refund-policy",
    deliveryTermsUrl: "https://shop.example.org/delivery",
  } as never);

  it("checks only the keys that have a link", async () => {
    const checks = await checkPolicyLinks({
      shop,
      shopDomain: "shop.myshopify.com",
      fetchImpl: (async () => response("a".repeat(400))) as never,
      lookup: lookupTo(["93.184.216.34"]),
      now: new Date("2026-10-31T00:00:00.000Z"),
    });
    expect(Object.keys(checks).sort()).toEqual(["deliveryTerms", "returnPolicy"]);
    for (const check of Object.values(checks)) {
      expect(check.ok).toBe(true);
      expect(check.checkedAt.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    }
  });

  it("fails a link that answers with an error status", async () => {
    const checks = await checkPolicyLinks({
      shop,
      shopDomain: "shop.myshopify.com",
      fetchImpl: (async () => response("not found", { status: 404 })) as never,
      lookup: lookupTo(["93.184.216.34"]),
    });
    expect(checks.returnPolicy!.ok).toBe(false);
    expect(checks.returnPolicy!.status).toBe(404);
    expect(checks.returnPolicy!.error).toContain("404");
  });

  it("marks a page that answers but looks empty or like a password page", async () => {
    for (const body of ["", "Enter store password to continue"]) {
      const checks = await checkPolicyLinks({
        shop,
        shopDomain: "shop.myshopify.com",
        fetchImpl: (async () => response(body)) as never,
        lookup: lookupTo(["93.184.216.34"]),
      });
      expect(checks.returnPolicy!.ok, JSON.stringify(body)).toBe(false);
      expect(checks.returnPolicy!.contentSuspect).toBe(true);
      expect(checks.returnPolicy!.error).toBeTruthy();
    }
  });

  it("records the refusal reason when the link is not fetchable", async () => {
    const checks = await checkPolicyLinks({
      shop,
      shopDomain: "shop.myshopify.com",
      fetchImpl: (async () => response("secret")) as never,
      lookup: lookupTo(["127.0.0.1"]),
    });
    expect(checks.returnPolicy!.ok).toBe(false);
    expect(checks.returnPolicy!.error).toContain("refused");
    expect(checks.returnPolicy!.url).toBe("https://shop.myshopify.com/policies/refund-policy");
  });
});
