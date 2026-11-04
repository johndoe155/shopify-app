import { describe, expect, it } from "vitest";
import { isBillingTestMode } from "~/services/billing.server";

describe("isBillingTestMode", () => {
  it("is driven by BILLING_TEST_MODE, not NODE_ENV", () => {
    expect(isBillingTestMode({ NODE_ENV: "production", BILLING_TEST_MODE: "true" })).toBe(true);
    expect(isBillingTestMode({ NODE_ENV: "production", BILLING_TEST_MODE: "1" })).toBe(true);
    expect(isBillingTestMode({ NODE_ENV: "development", BILLING_TEST_MODE: "false" })).toBe(false);
    expect(isBillingTestMode({ NODE_ENV: "development", BILLING_TEST_MODE: " OFF " })).toBe(false);
  });

  it("falls back to the old rule when it is unset, so production can never default to test charges", () => {
    expect(isBillingTestMode({ NODE_ENV: "production" })).toBe(false);
    expect(isBillingTestMode({ NODE_ENV: "development" })).toBe(true);
    expect(isBillingTestMode({})).toBe(true);
  });

  it("ignores an unrecognised value", () => {
    expect(isBillingTestMode({ NODE_ENV: "production", BILLING_TEST_MODE: "maybe" })).toBe(false);
  });
});
