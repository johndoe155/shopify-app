/**
 * Configuration guardrails (release blocker: "placeholders and config").
 *
 * The app used to read `SUPPORT_EMAIL ?? "support@example.com"` and point its
 * review button at the generic App Store home page. These tests pin the new
 * behaviour: placeholders are recognised, hidden from merchants, and fatal in
 * production.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeConfig,
  configProblems,
  isPlaceholder,
  optionalGaps,
  readConfig,
  resetConfigAssertionForTests,
} from "~/config.server";

const GOOD_ENV = {
  NODE_ENV: "production",
  SHOPIFY_API_KEY: "abc123",
  SHOPIFY_API_SECRET: "shhh",
  SHOPIFY_APP_URL: "https://legal-mrp.example.app",
  DATABASE_URL: "postgresql://user:pass@db:5432/legal",
  JOBS_SECRET: "a-long-random-value",
  SUPPORT_EMAIL: "help@legal-mrp.example.app",
  SHOPIFY_APP_REVIEW_URL: "https://apps.shopify.com/india-legal-mrp/reviews/new",
} satisfies NodeJS.ProcessEnv;

describe("placeholder detection", () => {
  it("recognises the shapes placeholders actually take", () => {
    expect(isPlaceholder("REPLACE_WITH_CLIENT_ID")).toBe(true);
    expect(isPlaceholder("https://REPLACE_WITH_HOST")).toBe(true);
    expect(isPlaceholder("support@example.com")).toBe(true);
    expect(isPlaceholder("https://apps.shopify.com/")).toBe(true);
    expect(isPlaceholder("replace-with-api-key")).toBe(true);
  });

  it("does not flag real values or empty strings", () => {
    expect(isPlaceholder("https://legal-mrp.example.org")).toBe(false);
    expect(isPlaceholder("help@legal-mrp.in")).toBe(false);
    expect(isPlaceholder("")).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
  });
});

describe("config problems", () => {
  it("accepts a fully configured production environment", () => {
    expect(configProblems(readConfig(GOOD_ENV))).toEqual([]);
  });

  it("names every missing required variable", () => {
    const problems = configProblems(readConfig({ NODE_ENV: "production" }));
    expect(problems.join("\n")).toMatch(/SHOPIFY_API_KEY/);
    expect(problems.join("\n")).toMatch(/SHOPIFY_API_SECRET/);
    expect(problems.join("\n")).toMatch(/SHOPIFY_APP_URL/);
    expect(problems.join("\n")).toMatch(/DATABASE_URL/);
    expect(problems.join("\n")).toMatch(/JOBS_SECRET/);
  });

  it("treats an unset or placeholder value the same way, so the placeholder can never be used", () => {
    const config = readConfig({ ...GOOD_ENV, SHOPIFY_API_KEY: "REPLACE_WITH_CLIENT_ID" });
    expect(config.apiKey).toBe("");
    expect(configProblems(config)).toContain("SHOPIFY_API_KEY is missing or still a placeholder");
  });

  it("does not fall back to example.com for support or to the App Store home page for reviews", () => {
    const config = readConfig({
      ...GOOD_ENV,
      SUPPORT_EMAIL: "support@example.com",
      SHOPIFY_APP_REVIEW_URL: "",
    });
    expect(config.supportEmail).toBe("");
    expect(config.reviewUrl).toBe("");
    expect(optionalGaps(config)).toHaveLength(2);
  });

  it("rejects a non-https app URL", () => {
    const problems = configProblems(
      readConfig({ ...GOOD_ENV, SHOPIFY_APP_URL: "http://localhost:3000" }),
    );
    expect(problems.join("\n")).toMatch(/https/);
  });

  it("is silent about required values in demo mode, which has no Shopify session", () => {
    expect(configProblems(readConfig({ DEMO_MODE: "1" }))).toEqual([]);
  });
});

describe("assertRuntimeConfig", () => {
  it("throws in production when a required value is a placeholder", () => {
    resetConfigAssertionForTests();
    expect(() =>
      assertRuntimeConfig({ ...GOOD_ENV, SHOPIFY_APP_SECRET: "", SHOPIFY_API_SECRET: "" }),
    ).toThrow(/SHOPIFY_API_SECRET/);
  });

  it("refuses to run the unauthenticated preview store in production", () => {
    resetConfigAssertionForTests();
    expect(() => assertRuntimeConfig({ ...GOOD_ENV, DEMO_MODE: "1" })).toThrow(/DEMO_MODE_SECRET/);
  });

  it("allows the documented preview app, which sets the opt-in itself", () => {
    resetConfigAssertionForTests();
    expect(() =>
      assertRuntimeConfig({ ...GOOD_ENV, DEMO_MODE: "1", DEMO_MODE_SECRET: "local-preview-only" }),
    ).not.toThrow();
  });

  it("only warns outside production, so the preview app still runs", () => {
    resetConfigAssertionForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertRuntimeConfig({ NODE_ENV: "development" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes a correctly configured production environment", () => {
    resetConfigAssertionForTests();
    expect(() => assertRuntimeConfig(GOOD_ENV)).not.toThrow();
  });
});
