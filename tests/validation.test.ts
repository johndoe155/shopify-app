import { describe, expect, it } from "vitest";
import {
  parseCountry,
  parseMoney,
  parseMonthYear,
  parseNetQuantity,
  parseUnit,
  sanitizeMultilineText,
  sanitizeText,
  validateEmail,
  validateLegalPatch,
  validatePhone,
  validatePolicyLink,
  validateQuantityPair,
} from "~/domain/validation";
import { validateShopSettings } from "~/services/shop-settings.server";

function ok<T>(result: { ok: boolean }): asserts result is { ok: true; value: T } {
  expect(result.ok).toBe(true);
}

describe("money", () => {
  it("accepts plain numbers, commas and a currency symbol", () => {
    for (const input of ["249", "1,299.00", " 249.50 ", "₹249"]) {
      const result = parseMoney(input);
      ok<number>(result);
      expect(typeof result.value).toBe("number");
    }
    expect((parseMoney("1,299.00") as { value: number }).value).toBe(1299);
  });

  it("accepts an empty value as 'clear the field'", () => {
    const result = parseMoney("");
    ok<null>(result);
    expect(result.value).toBeNull();
  });

  it("rejects zero, negatives, three decimals, text and absurd amounts", () => {
    for (const input of ["0", "-5", "10.999", "abc", "9,999,999,999"]) {
      expect(parseMoney(input).ok).toBe(false);
    }
  });
});

describe("net quantity", () => {
  it("accepts whole numbers and up to three decimals", () => {
    expect(parseNetQuantity("100")).toEqual({ ok: true, value: 100 });
    expect(parseNetQuantity("2.5")).toEqual({ ok: true, value: 2.5 });
  });

  it("rejects zero and junk", () => {
    expect(parseNetQuantity("0").ok).toBe(false);
    expect(parseNetQuantity("1/2").ok).toBe(false);
  });

  it("allows the Rule 13 units, including the count descriptors", () => {
    expect(parseUnit("ml")).toEqual({ ok: true, value: "ml" });
    expect(parseUnit("ML")).toEqual({ ok: true, value: "ml" });
    expect(parseUnit("cm")).toEqual({ ok: true, value: "cm" });
    expect(parseUnit("pair")).toEqual({ ok: true, value: "pair" });
    // The legacy spelling is normalised rather than rejected.
    expect(parseUnit("pcs")).toEqual({ ok: true, value: "piece" });
    expect(parseUnit("grams").ok).toBe(false);
    expect(parseUnit("oz").ok).toBe(false);
  });

  it("requires the value and the unit to arrive together", () => {
    const result = validateQuantityPair("100", "");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("netQuantityUnit");
    const reverse = validateQuantityPair("", "g");
    expect(reverse.errors[0]!.field).toBe("netQuantityValue");
  });
});

describe("month/year dates", () => {
  it("normalises to MM/YYYY", () => {
    expect(parseMonthYear("3/2026")).toEqual({ ok: true, value: "03/2026" });
    expect(parseMonthYear("03-2026")).toEqual({ ok: true, value: "03/2026" });
  });

  it("rejects impossible months and out-of-range years", () => {
    expect(parseMonthYear("13/2026").ok).toBe(false);
    expect(parseMonthYear("00/2026").ok).toBe(false);
    expect(parseMonthYear("03/1800").ok).toBe(false);
  });

  it("rejects free text and ISO dates", () => {
    expect(parseMonthYear("March 2026").ok).toBe(false);
    expect(parseMonthYear("2026-03-01").ok).toBe(false);
  });
});

describe("country", () => {
  it("canonicalises a name from the list", () => {
    expect(parseCountry("india")).toEqual({ ok: true, value: "India" });
    expect(parseCountry("IN")).toEqual({ ok: true, value: "India" });
  });

  it("rejects a value that is not in the list", () => {
    expect(parseCountry("Atlantis").ok).toBe(false);
  });
});

describe("text", () => {
  it("strips angle brackets and control characters", () => {
    expect(sanitizeText("<script>alert(1)</script>")).toBe("script alert(1) /script");
    expect(sanitizeText("  lots   of   space ")).toBe("lots of space");
  });

  it("keeps line breaks in multiline text", () => {
    expect(sanitizeMultilineText("Line one\nLine two")).toBe("Line one\nLine two");
  });

  it("returns null for blank input so a field can be cleared", () => {
    expect(sanitizeText("   ")).toBeNull();
  });
});

describe("email, phone and links", () => {
  it("validates email addresses", () => {
    expect(validateEmail("care@example.com").ok).toBe(true);
    expect(validateEmail("not-an-email").ok).toBe(false);
    expect(validateEmail("").ok).toBe(true);
    expect(validateEmail("", { required: true }).ok).toBe(false);
  });

  it("validates phone numbers", () => {
    expect(validatePhone("+91 80 4123 7788").ok).toBe(true);
    expect(validatePhone("12345").ok).toBe(false);
    expect(validatePhone("abcdefghij").ok).toBe(false);
  });

  it("accepts a storefront path or an https link, nothing else", () => {
    expect(validatePolicyLink("/pages/returns").ok).toBe(true);
    expect(validatePolicyLink("https://example.com/returns").ok).toBe(true);
    expect(validatePolicyLink("ftp://example.com").ok).toBe(false);
    expect(validatePolicyLink("example.com/returns").ok).toBe(false);
    expect(validatePolicyLink("javascript:alert(1)").ok).toBe(false);
  });
});

describe("legal patch", () => {
  it("returns only the fields that were supplied", () => {
    const result = validateLegalPatch({ mrp: "249", genericName: "face wash" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ mrp: 249, genericName: "face wash" });
  });

  it("collects a per-field error for every bad value", () => {
    const result = validateLegalPatch({ mrp: "x", netQuantityUnit: "oz", expiryDate: "soon" });
    expect(result.errors.map((error) => error.field).sort()).toEqual([
      "expiryDate",
      "mrp",
      "netQuantityUnit",
    ]);
  });

  it("refuses a best-before date without its type", () => {
    const result = validateLegalPatch({ expiryDate: "03/2026" });
    expect(result.errors[0]!.field).toBe("expiryType");
  });

  it("accepts a best-before date with its type", () => {
    const result = validateLegalPatch({ expiryDate: "03/2026", expiryType: "best_before" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ expiryDate: "03/2026", expiryType: "best_before" });
  });

  it("keeps the manufacture date and the best-before date separate", () => {
    // Audit item L9: one date field with a type switch was the defect. A
    // manufacture date is written without touching the expiry pair.
    const result = validateLegalPatch({ manufacturedDate: "03/2026" });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ manufacturedDate: "03/2026" });
  });

  it("rejects a best-before date earlier than the manufacture date", () => {
    const result = validateLegalPatch(
      { expiryDate: "01/2026", expiryType: "best_before" },
      { manufacturedDate: "03/2026" },
    );
    expect(result.errors.map((error) => error.field)).toContain("expiryDate");
  });

  it("parses the imported-package flag and the per-variant price map", () => {
    const result = validateLegalPatch({
      isImportedPackage: "true",
      genericNameOnLabel: "false",
      variantMrp: { "gid://shopify/ProductVariant/1": "349" },
    });
    expect(result.errors).toEqual([]);
    expect(result.values.isImportedPackage).toBe(true);
    expect(result.values.genericNameOnLabel).toBe(false);
    expect(result.values.variantMrp).toEqual({ "gid://shopify/ProductVariant/1": 349 });
  });
});

describe("store settings validation", () => {
  const base = {
    storeName: "Aranya Naturals",
    consumerCareAddress: "12 Industrial Estate, Bengaluru 560001, Karnataka",
    consumerCarePhone: "+91 80 4123 7788",
    consumerCareEmail: "care@example.com",
    grievanceName: "Priya Menon",
    grievanceDesignation: "Grievance Officer",
    grievanceEmail: "grievance@example.com",
    grievancePhone: "+91 80 4123 7799",
    returnPolicyUrl: "/pages/returns",
    returnPolicyText: "",
    refundPolicyUrl: "/pages/refunds",
    refundPolicyText: "",
    exchangePolicyUrl: "/pages/exchanges",
    exchangePolicyText: "",
    warrantyPolicyUrl: "/pages/warranty",
    warrantyPolicyText: "",
    deliveryTermsUrl: "/pages/shipping",
    deliveryTermsText: "",
    returnShippingCostUrl: "",
    returnShippingCostText: "Free for damaged items",
    platformCustomerCareUrl: "/pages/contact",
    paymentModesUrl: "/pages/payment-methods",
    paymentModesText: "",
    grievanceRedressalUrl: "/pages/grievance-redressal",
    grievanceRedressalText: "",
    otherInformationUrl: "",
    otherInformationText: "Country of origin is printed on each pack",
    useBeforeInfoUrl: "",
    useBeforeInfoText: "",
    confirmDeclarationsBlock: true,
    confirmGrievanceBlock: false,
    confirmPriorPriceBlock: true,
  };

  it("accepts a complete form", () => {
    expect(validateShopSettings(base).errors).toEqual([]);
  });

  it("rejects a bad grievance email and a bad policy link", () => {
    const { errors } = validateShopSettings({ ...base, grievanceEmail: "nope", returnPolicyUrl: "not a link" });
    expect(errors.map((error) => error.field).sort()).toEqual(["grievanceEmail", "returnPolicyUrl"]);
  });

  it("keeps the block confirmations as booleans", () => {
    const { patch } = validateShopSettings(base);
    expect(patch.confirmDeclarationsBlock).toBe(true);
    expect(patch.confirmGrievanceBlock).toBe(false);
  });

  it("accepts the address without requiring a phone or email", () => {
    const { patch, errors } = validateShopSettings({
      ...base,
      consumerCarePhone: "",
      consumerCareEmail: "",
    });
    expect(errors).toEqual([]);
    expect(patch.consumerCareAddress).toBe("12 Industrial Estate, Bengaluru 560001, Karnataka");
  });

  it("requires the payment-mode and grievance-redressal disclosures", () => {
    const { patch } = validateShopSettings({ ...base, paymentModesUrl: "", grievanceRedressalUrl: "" });
    expect(patch.paymentModesUrl).toBeNull();
    expect(patch.grievanceRedressalUrl).toBeNull();
  });
});
