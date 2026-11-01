import { describe, expect, it } from "vitest";
import {
  RULES_CONFIG,
  evaluateProduct,
  evaluateProductRules,
  evaluateStoreRules,
  ruleEntries,
  summariseScan,
} from "~/domain/rules";
import type {
  LegalFields,
  PolicyLinkCheck,
  ProductFacts,
  RuleStatus,
  StoreFacts,
  VariantPriorPrice,
} from "~/domain/types";
import { makeLegalFields, makeShop } from "./helpers";
import { toStoreFacts } from "~/db/types";

function storeFacts(overrides: Partial<StoreFacts> = {}): StoreFacts {
  const shop = makeShop();
  const facts = toStoreFacts(shop, shop.blocksDetected);
  return {
    ...facts,
    complaints: { total: 0, open: 0, overdueAcknowledgement: 0, overdueResolution: 0, lastReceivedAt: null },
    lastAuditAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function completePriorPrice(overrides: Partial<VariantPriorPrice> = {}): VariantPriorPrice {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    priorPrice: 299,
    historyComplete: true,
    trackedSince: new Date("2026-07-01T00:00:00.000Z"),
    completeBy: new Date("2026-07-31T00:00:00.000Z"),
    windowDays: 30,
    daysOfHistory: 30,
    hasSnapshots: true,
    announcement: {
      announcedAt: new Date("2026-08-01T00:00:00.000Z"),
      consumerPrice: 249,
      mechanism: "compare_at",
      conditions: null,
    },
    // Derived by the app from the compare-at price, not typed in by the merchant.
    announcementRecorded: false,
    ...overrides,
  };
}

function product(
  overrides: Partial<Omit<ProductFacts, "legal">> & { legal?: Partial<LegalFields> } = {},
): ProductFacts {
  const { legal, ...rest } = overrides;
  return {
    productId: "gid://shopify/Product/1",
    handle: "test-product",
    title: "Test product",
    vendor: "Aranya Naturals",
    productType: "Beauty & personal care",
    status: "ACTIVE",
    legal: makeLegalFields(legal),
    variants: [
      { variantId: "gid://shopify/ProductVariant/1", title: "Default", price: 249, compareAtPrice: null, priorPrice: null },
    ],
    priorPricePublished: false,
    ...rest,
  };
}

/** A reduced-price product with a complete prior-price history and announcement. */
function discountedProduct(): ProductFacts {
  return product({
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        title: "Default",
        price: 249,
        compareAtPrice: 399,
        priorPrice: completePriorPrice(),
      },
    ],
    priorPricePublished: true,
  });
}

function statusOf(results: ReturnType<typeof evaluateProductRules>, ruleId: string): RuleStatus {
  const found = results.find((r) => r.ruleId === ruleId);
  if (!found) throw new Error(`No result for ${ruleId}`);
  return found.status;
}

describe("rule configuration", () => {
  it("publishes thirteen enabled rules, R13 included", () => {
    const ids = ruleEntries().map((rule) => rule.id);
    expect(ids).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R11", "R13", "R8", "R9", "R10", "R12"].sort((a, b) =>
      ids.indexOf(a) - ids.indexOf(b),
    ));
    expect(ids).toContain("R13");
    expect(RULES_CONFIG.rules.find((rule) => rule.id === "R13")?.enabled).toBe(true);
  });

  it("keeps the draft version and the unverified flag (audit item 23)", () => {
    expect(RULES_CONFIG.verifiedAgainstGazette).toBe(false);
    expect(RULES_CONFIG.version).toBe("2026.1-draft");
  });

  it("no longer carries the country-code or date-type parameters (audit item 21)", () => {
    const parameters = RULES_CONFIG.parameters as unknown as Record<string, unknown>;
    expect(parameters.importerRequiredUnlessCountryCode).toBeUndefined();
    expect(parameters.dateSensitiveWhenDateTypeIsNot).toBeUndefined();
    expect(parameters.priorPriceWindowDays).toBe(30);
    expect(parameters.auditValidityMonths).toBe(12);
    expect(parameters.auditReminderMonths).toBe(11);
    expect(parameters.auditCadenceIsProductPolicy).toBe(true);
  });

  it("points every rule at a provision (audit item 20)", () => {
    for (const rule of RULES_CONFIG.rules) {
      expect(rule.sources?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("R1 retail sale price per package", () => {
  it("passes when the price is at or below the declared MRP", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R1")).toBe("pass");
  });

  it("fails when a variant sells above the declared price", () => {
    const p = product({
      variants: [
        { variantId: "gid://shopify/ProductVariant/1", title: "Default", price: 349, compareAtPrice: null, priorPrice: null },
      ],
    });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R1")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("mrp");
  });

  it("reads a per-variant MRP where the variants are separate packages", () => {
    const p = product({
      legal: { variantMrp: { "gid://shopify/ProductVariant/1": 400 } },
      variants: [
        { variantId: "gid://shopify/ProductVariant/1", title: "Default", price: 349, compareAtPrice: null, priorPrice: null },
      ],
    });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R1")).toBe("pass");
  });

  it("is not applicable to a package outside the Rules 3/26 scope", () => {
    const p = product({ legal: { packageType: "wholesale" } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R1")).toBe("not_applicable");
  });
});

describe("R2 manufacturer, packer, importer, seller and online display", () => {
  it("passes for a complete declaration with the block detected", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R2")).toBe("pass");
  });

  it("fails when the manufacturer address is missing", () => {
    const p = product({ legal: { manufacturerAddress: null } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R2")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("manufacturer_address");
  });

  it("requires a packer only where the packer is declared as a different person", () => {
    const declared = product({ legal: { packerDiffersFromManufacturer: true } });
    const result = evaluateProductRules(declared, storeFacts()).find((r) => r.ruleId === "R2")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toEqual(expect.arrayContaining(["packer_name", "packer_address"]));

    const filled = product({
      legal: {
        packerDiffersFromManufacturer: true,
        packerName: "Aranya Packing Unit",
        packerAddress: "22 Packing Estate, Hyderabad 500001, Telangana",
      },
    });
    expect(statusOf(evaluateProductRules(filled, storeFacts()), "R2")).toBe("pass");
  });

  it("reports a half-filled seller pair rather than ignoring it", () => {
    const p = product({ legal: { sellerName: "Aranya Retail" } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R2")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("seller_address");
  });

  it("fails when the declarations are not displayed online (Rule 6(10))", () => {
    const store = storeFacts({ blocks: { declarations: "not_found", grievance: "detected", priorPrice: "detected" } });
    const result = evaluateProductRules(product(), store).find((r) => r.ruleId === "R2")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("declarations_block");
  });

  it("is inconclusive, not failing, when the block cannot be seen", () => {
    const store = storeFacts({ blocks: { declarations: "unknown", grievance: "detected", priorPrice: "detected" } });
    expect(statusOf(evaluateProductRules(product(), store), "R2")).toBe("inconclusive");
  });
});

describe("R3 country of origin and label wording", () => {
  it("passes with a canonical country and the pack wording", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R3")).toBe("pass");
  });

  it("fails without the wording printed on the pack", () => {
    const p = product({ legal: { countryOfOriginLabel: null } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R3")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("country_of_origin_label");
  });

  it("fails when the country is not recognised", () => {
    const p = product({ legal: { countryOfOrigin: "Atlantis" } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R3")).toBe("fail");
  });
});

describe("R4 importer details", () => {
  it("is not applicable when the package is marked as not imported", () => {
    const p = product({ legal: { countryOfOrigin: "India", isImportedPackage: false } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R4")).toBe("not_applicable");
  });

  it("requires importer details when the imported-package flag is set", () => {
    const p = product({ legal: { countryOfOrigin: "China", isImportedPackage: true } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R4")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toEqual(expect.arrayContaining(["importer_name", "importer_address"]));
  });

  it("passes with importer name and address on an imported package", () => {
    const p = product({
      legal: {
        countryOfOrigin: "China",
        isImportedPackage: true,
        importerName: "Aranya Imports Pvt Ltd",
        importerAddress: "MG Road, Mumbai 400001, Maharashtra",
      },
    });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R4")).toBe("pass");
  });

  it("does not treat an Indian country code as a legal exemption: the flag decides", () => {
    // An Indian country of origin with the imported flag set still needs importer
    // details, because the flag is the declaration and the country is only data.
    const p = product({ legal: { countryOfOrigin: "India", isImportedPackage: true } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R4")).toBe("fail");
  });

  it("stays not applicable while neither the flag nor the country is set", () => {
    const p = product({ legal: { countryOfOrigin: null, isImportedPackage: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R4")).toBe("not_applicable");
  });
});

describe("R5 net quantity", () => {
  it("passes with a value and a unit", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R5")).toBe("pass");
  });

  it("fails without a value", () => {
    const p = product({ legal: { netQuantityValue: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R5")).toBe("fail");
  });

  it("fails without a unit", () => {
    const p = product({ legal: { netQuantityUnit: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R5")).toBe("fail");
  });

  it("applies the Rule 13 threshold for mass", () => {
    const p = product({ legal: { netQuantityValue: 1500, netQuantityUnit: "g" } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R5")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("1.5 kg");
  });

  it("accepts the count descriptors and the centimetre unit", () => {
    const count = product({ legal: { netQuantityValue: 6, netQuantityUnit: "piece" } });
    expect(statusOf(evaluateProductRules(count, storeFacts()), "R5")).toBe("pass");
    const length = product({ legal: { netQuantityValue: 45, netQuantityUnit: "cm" } });
    expect(statusOf(evaluateProductRules(length, storeFacts()), "R5")).toBe("pass");
  });
});

describe("R6 common name", () => {
  it("fails when blank", () => {
    const p = product({ legal: { genericName: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R6")).toBe("fail");
  });

  it("fails when the name is only in the online title", () => {
    const p = product({ legal: { genericNameOnLabel: false } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R6")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("generic_name_on_label");
  });

  it("passes when the name is confirmed on the pack", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R6")).toBe("pass");
  });
});

describe("R7 manufacture date and best-before/use-by", () => {
  it("passes with a manufacture date and no expiry requirement", () => {
    const p = product({ legal: { manufacturedDate: "03/2026", expiryType: "none", expiryDate: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R7")).toBe("pass");
  });

  it("fails when the manufacture date is missing, whatever the old date-type flag said", () => {
    const p = product({ legal: { manufacturedDate: null } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R7")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("manufactured_date");
  });

  it("fails when the manufacture date is not in MM/YYYY form", () => {
    const p = product({ legal: { manufacturedDate: "2026-03" } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R7")).toBe("fail");
  });

  it("requires a best-before date once the commodity is declared as expiring", () => {
    const p = product({ legal: { expiryType: "best_before", expiryDate: null } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R7")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("expiry_date");
  });

  it("passes with both dates recorded", () => {
    const p = product({ legal: { expiryType: "use_by", expiryDate: "03/2027" } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R7")).toBe("pass");
  });
});

describe("R11 prior price", () => {
  it("is not applicable when nothing is discounted", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R11")).toBe("not_applicable");
  });

  it("passes for a reduced variant published from a complete lookback", () => {
    expect(statusOf(evaluateProductRules(discountedProduct(), storeFacts()), "R11")).toBe("pass");
  });

  it("is inconclusive when the block cannot be seen", () => {
    const store = storeFacts({ blocks: { declarations: "detected", grievance: "detected", priorPrice: "unknown" } });
    expect(statusOf(evaluateProductRules(discountedProduct(), store), "R11")).toBe("inconclusive");
  });

  it("fails when the block is not live", () => {
    const store = storeFacts({ blocks: { declarations: "detected", grievance: "detected", priorPrice: "not_found" } });
    expect(statusOf(evaluateProductRules(discountedProduct(), store), "R11")).toBe("fail");
  });

  it("fails, rather than labelling it, when the lookback is incomplete", () => {
    const p = product({
      variants: [
        {
          variantId: "gid://shopify/ProductVariant/1",
          title: "Default",
          price: 249,
          compareAtPrice: 399,
          priorPrice: completePriorPrice({ historyComplete: false, priorPrice: null, daysOfHistory: 12 }),
        },
      ],
      priorPricePublished: false,
    });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R11")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("covers only part of the 30 days");
    expect(result.message).toContain("no prior price is published");
    expect(result.message).not.toContain("tracked since install");
  });

  it("fails when the announcement event is not recorded", () => {
    const p = product({
      variants: [
        {
          variantId: "gid://shopify/ProductVariant/1",
          title: "Default",
          price: 249,
          compareAtPrice: 399,
          priorPrice: completePriorPrice({ announcement: null }),
        },
      ],
      priorPricePublished: true,
    });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R11")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("prior_price_announcement");
  });

  it("accepts a discount code as the recorded announcement mechanism", () => {
    const p = product({
      variants: [
        {
          variantId: "gid://shopify/ProductVariant/1",
          title: "Default",
          price: 249,
          compareAtPrice: 399,
          priorPrice: completePriorPrice({
            announcement: {
              announcedAt: new Date("2026-08-01T00:00:00.000Z"),
              consumerPrice: 224,
              mechanism: "discount_code",
              conditions: "Code MONSOON, one per customer",
            },
            // Only a merchant can record a code: the app cannot see one.
            announcementRecorded: true,
          }),
        },
      ],
      priorPricePublished: true,
    });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R11")!;
    expect(result.status).toBe("pass");
    expect(result.message).toContain("discount code");
  });

  it("fails when the metafield has not been published", () => {
    const p = { ...discountedProduct(), priorPricePublished: false };
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R11")).toBe("fail");
  });
});

describe("R13 unit sale price", () => {
  it("passes when the declared unit price matches the MRP and quantity", () => {
    expect(statusOf(evaluateProductRules(product(), storeFacts()), "R13")).toBe("pass");
  });

  it("fails when the unit price is not declared", () => {
    const p = product({ legal: { unitSalePrice: null } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R13")!;
    expect(result.status).toBe("fail");
    expect(result.fields).toContain("unit_sale_price");
  });

  it("fails when the unit price does not match, to two decimal places", () => {
    const p = product({ legal: { unitSalePrice: 31 } });
    const result = evaluateProductRules(p, storeFacts()).find((r) => r.ruleId === "R13")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("3.00");
    expect(result.message).toContain("per ml");
  });

  it("is not applicable where the retail sale price equals the unit sale price", () => {
    // One piece at ₹300: the retail price is the unit price.
    const p = product({ legal: { mrp: 300, netQuantityValue: 1, netQuantityUnit: "piece", unitSalePrice: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R13")).toBe("not_applicable");
  });

  it("is not applicable outside the Rules 3/26 scope", () => {
    const p = product({ legal: { packageType: "excluded", unitSalePrice: null } });
    expect(statusOf(evaluateProductRules(p, storeFacts()), "R13")).toBe("not_applicable");
  });

  it("does not treat an unreadable quantity as an exemption, but reports it through R5", () => {
    const p = product({ legal: { netQuantityValue: null, unitSalePrice: null } });
    const results = evaluateProductRules(p, storeFacts());
    expect(statusOf(results, "R13")).toBe("not_applicable");
    expect(statusOf(results, "R5")).toBe("fail");
  });
});

describe("R8 package-label contact and platform customer care", () => {
  it("passes with a name, an address and a platform contact", () => {
    expect(statusOf(evaluateStoreRules(storeFacts()), "R8")).toBe("pass");
  });

  it("fails without the address, even when a phone and email are entered", () => {
    const store = storeFacts({
      consumerCare: { storeName: "Aranya", address: null, phone: "+91 80 4123 7788", email: "care@example.com" },
    });
    const result = evaluateStoreRules(store).find((r) => r.ruleId === "R8")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("contact address");
  });

  it("treats telephone and e-mail as optional", () => {
    const store = storeFacts({
      consumerCare: { storeName: "Aranya", address: "12 Industrial Estate, Bengaluru", phone: null, email: null },
    });
    const result = evaluateStoreRules(store).find((r) => r.ruleId === "R8")!;
    expect(result.status).toBe("pass");
    expect(result.message).toContain("not available");
  });

  it("fails when there is no platform customer-care contact at all", () => {
    const store = storeFacts({
      consumerCare: { storeName: "Aranya", address: "12 Industrial Estate, Bengaluru", phone: null, email: null },
      platformCustomerCareUrl: null,
    });
    expect(statusOf(evaluateStoreRules(store), "R8")).toBe("fail");
  });
});

describe("R9 pre-purchase disclosures", () => {
  /** Two days old: inside the 7-day freshness window R9 applies to link checks. */
  const checkedAt = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  const checked = (key: string, when: Date = checkedAt(2)) => ({
    [key]: {
      url: "/policy",
      ok: true,
      status: 200,
      checkedAt: when,
      contentSuspect: false,
      error: null,
    },
  });

  function allChecks(daysAgo = 2): Record<string, PolicyLinkCheck> {
    return [
      "returnPolicy",
      "refundPolicy",
      "exchangePolicy",
      "warrantyPolicy",
      "deliveryTerms",
      "returnShippingCost",
      "paymentModes",
      "grievanceRedressal",
      "otherInformation",
    ].reduce<Record<string, PolicyLinkCheck>>(
      (acc, key) => ({ ...acc, ...checked(key, checkedAt(daysAgo)) }),
      {},
    );
  }

  it("passes when every required disclosure has a link that answered", () => {
    expect(statusOf(evaluateStoreRules(storeFacts({ policyLinkChecks: allChecks() })), "R9")).toBe("pass");
  });

  it("fails when a disclosure that the old six-item list did not include is missing", () => {
    const store = storeFacts({ policyLinkChecks: allChecks(), policies: {
      ...storeFacts().policies,
      paymentModes: { url: null, text: null },
    } });
    const result = evaluateStoreRules(store).find((r) => r.ruleId === "R9")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("modes of payment");
  });

  it("fails when a link did not load", () => {
    const checks = allChecks();
    checks.returnPolicy = { ...checks.returnPolicy!, ok: false, status: 404 };
    const result = evaluateStoreRules(storeFacts({ policyLinkChecks: checks })).find((r) => r.ruleId === "R9")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("did not load");
  });

  it("is inconclusive when a link has never been checked", () => {
    const store = storeFacts({ policyLinkChecks: {} });
    expect(statusOf(evaluateStoreRules(store), "R9")).toBe("inconclusive");
  });

  it("is inconclusive when a link check is older than the freshness window", () => {
    // A page that answered in September says nothing about October: the window is
    // what stops R9 passing on a link that has since broken.
    const result = evaluateStoreRules(storeFacts({ policyLinkChecks: allChecks(30) })).find(
      (r) => r.ruleId === "R9",
    )!;
    expect(result.status).toBe("inconclusive");
    expect(result.message).toContain("more than 7 days ago");
  });

  it("passes again once the link is re-checked", () => {
    const stale = evaluateStoreRules(storeFacts({ policyLinkChecks: allChecks(30) })).find(
      (r) => r.ruleId === "R9",
    )!;
    const fresh = evaluateStoreRules(storeFacts({ policyLinkChecks: allChecks(0) })).find(
      (r) => r.ruleId === "R9",
    )!;
    expect(stale.status).toBe("inconclusive");
    expect(fresh.status).toBe("pass");
  });

  it("takes the freshness window from the configuration", () => {
    const cfg = {
      ...RULES_CONFIG,
      parameters: { ...RULES_CONFIG.parameters, policyLinkMaxAgeDays: 1 },
    };
    const result = evaluateStoreRules(storeFacts({ policyLinkChecks: allChecks(3) }), cfg).find(
      (r) => r.ruleId === "R9",
    )!;
    expect(result.status).toBe("inconclusive");
    expect(result.message).toContain("more than 1 day ago");
  });

  it("does not require best-before information for every store", () => {
    const store = storeFacts({
      policyLinkChecks: allChecks(),
      policies: { ...storeFacts().policies, useBeforeInfo: { url: null, text: null } },
    });
    expect(statusOf(evaluateStoreRules(store), "R9")).toBe("pass");
  });
});

describe("R10 grievance officer and complaint timings", () => {
  it("passes with complete details, a live block and no complaints", () => {
    const result = evaluateStoreRules(storeFacts()).find((r) => r.ruleId === "R10")!;
    expect(result.status).toBe("pass");
    expect(result.message).toContain("No complaints are recorded");
  });

  it("fails when a complaint was not acknowledged within 48 hours", () => {
    const store = storeFacts({
      complaints: { total: 2, open: 1, overdueAcknowledgement: 1, overdueResolution: 0, lastReceivedAt: new Date("2026-08-30T00:00:00.000Z") },
    });
    const result = evaluateStoreRules(store).find((r) => r.ruleId === "R10")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not acknowledged within 48 hours");
  });

  it("fails when a complaint was not redressed within one month", () => {
    const store = storeFacts({
      complaints: { total: 3, open: 2, overdueAcknowledgement: 0, overdueResolution: 2, lastReceivedAt: null },
    });
    const result = evaluateStoreRules(store).find((r) => r.ruleId === "R10")!;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not redressed within one month");
  });

  it("fails when the grievance officer details are incomplete", () => {
    const store = storeFacts({
      grievanceOfficer: { name: "Priya Menon", designation: null, email: "grievance@example.com", phone: "+91 80 4123 7799" },
    });
    expect(statusOf(evaluateStoreRules(store), "R10")).toBe("fail");
  });

  it("is inconclusive when the block cannot be verified", () => {
    const store = storeFacts({ blocks: { declarations: "detected", grievance: "unknown", priorPrice: "detected" } });
    expect(statusOf(evaluateStoreRules(store), "R10")).toBe("inconclusive");
  });
});

describe("R12 self-audit", () => {
  it("passes within the validity period and labels the cadence as app policy", () => {
    const result = evaluateStoreRules(storeFacts(), RULES_CONFIG, new Date("2026-09-01T00:00:00.000Z")).find(
      (r) => r.ruleId === "R12",
    )!;
    expect(result.status).toBe("pass");
    expect(result.message).toContain("app policy");
  });

  it("fails when no record exists", () => {
    const store = storeFacts({ lastAuditAt: null });
    expect(statusOf(evaluateStoreRules(store), "R12")).toBe("fail");
  });

  it("fails once the record is older than the configured period", () => {
    const store = storeFacts({ lastAuditAt: new Date("2025-01-01T00:00:00.000Z") });
    expect(statusOf(evaluateStoreRules(store, RULES_CONFIG, new Date("2026-09-01T00:00:00.000Z")), "R12")).toBe("fail");
  });
});

describe("scan summary", () => {
  it("reports thirteen rules and scores only the products it could read", () => {
    const outcomes = [evaluateProduct(product(), storeFacts()), evaluateProduct(discountedProduct(), storeFacts())];
    const summary = summariseScan(outcomes);
    expect(summary.byRule).toHaveLength(13);
    expect(summary.totalProducts).toBe(2);
    expect(summary.byRule.find((rule) => rule.ruleId === "R13")!.level).toBe("product");
  });

  it("keeps inconclusive products out of the score denominator", () => {
    const unknownBlocks = storeFacts({
      blocks: { declarations: "unknown", grievance: "detected", priorPrice: "detected" },
    });
    const outcomes = [
      evaluateProduct(product(), storeFacts()),
      evaluateProduct(product({ productId: "gid://shopify/Product/2" }), unknownBlocks),
    ];
    const summary = summariseScan(outcomes);
    expect(summary.inconclusiveProducts).toBe(1);
    expect(summary.scoredProducts).toBe(1);
    expect(summary.scorePercent).toBe(100);
    expect(summary.rawScorePercent).toBe(50);
  });

  it("counts a failure even when another check is unresolved", () => {
    const unknownBlocks = storeFacts({
      blocks: { declarations: "unknown", grievance: "detected", priorPrice: "detected" },
    });
    const outcome = evaluateProduct(product({ legal: { mrp: null } }), unknownBlocks);
    expect(outcome.status).toBe("fail");
  });
});
