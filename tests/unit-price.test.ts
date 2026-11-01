/**
 * Rule 6(11) unit sale price arithmetic.
 *
 * The rule quotes the price per **standard** unit, and the standard unit changes
 * with the threshold (g → kg at 1,000 g, ml → l at 1,000 ml, cm → m at 100 cm).
 * Getting the threshold wrong is a factor-of-1,000 error on the label, so these
 * cases pin the threshold, the rounding and the exemptions.
 */
import { describe, expect, it } from "vitest";
import type { NetQuantityUnit } from "~/domain/types";
import {
  assessUnitSalePrice,
  computeUnitSalePrice,
  declaredUnitSalePriceMatches,
  formatUnitSalePrice,
  isCountUnit,
  roundToPaise,
  standardQuantity,
  standardQuantityAndUnit,
  standardUnitCorrection,
  standardUnitLabel,
  UNIT_SPECS,
} from "~/domain/unit-price";

describe("standard quantity and unit", () => {
  it("keeps millilitres below the 1,000 ml threshold", () => {
    expect(standardQuantityAndUnit(500, "ml")).toEqual({ quantity: 500, unit: "ml" });
    expect(standardQuantityAndUnit(999, "ml")).toEqual({ quantity: 999, unit: "ml" });
  });

  it("switches to litres at the threshold, and the unit goes with it", () => {
    // The pair is produced together on purpose: "per litre" beside a millilitre
    // quantity would be wrong by a factor of 1,000.
    expect(standardQuantityAndUnit(1000, "ml")).toEqual({ quantity: 1, unit: "l" });
    expect(standardQuantityAndUnit(1500, "ml")).toEqual({ quantity: 1.5, unit: "l" });
  });

  it("switches grams to kilograms at 1,000 g and centimetres to metres at 100 cm", () => {
    expect(standardQuantityAndUnit(800, "g")).toEqual({ quantity: 800, unit: "g" });
    expect(standardQuantityAndUnit(2500, "g")).toEqual({ quantity: 2.5, unit: "kg" });
    expect(standardQuantityAndUnit(90, "cm")).toEqual({ quantity: 90, unit: "cm" });
    expect(standardQuantityAndUnit(250, "cm")).toEqual({ quantity: 2.5, unit: "m" });
  });

  it("leaves count units alone, including a pair", () => {
    expect(standardQuantityAndUnit(6, "piece")).toEqual({ quantity: 6, unit: "piece" });
    // A pair is quoted per pair, not per item: count quantities keep the unit they
    // were entered in, so `basePerOne` on a count spec is not applied here.
    expect(standardQuantityAndUnit(6, "pair")).toEqual({ quantity: 6, unit: "pair" });
  });

  it("applies the threshold to a quantity entered in the larger unit too", () => {
    // The threshold is on the quantity, not on the unit as typed: 2 kg is 2,000 g,
    // which is at and above 1,000 g, so the standard unit is kg. Reading it from
    // the unit as typed asked a merchant who entered "2 kg" to declare a price
    // "per gram", a thousand times too small.
    expect(standardQuantityAndUnit(2, "kg")).toEqual({ quantity: 2, unit: "kg" });
    expect(standardQuantityAndUnit(2.5, "m")).toEqual({ quantity: 2.5, unit: "m" });
    // Below the threshold the standard unit is the smaller one.
    expect(standardQuantityAndUnit(0.75, "l")).toEqual({ quantity: 750, unit: "ml" });
    expect(standardQuantityAndUnit(0.5, "kg")).toEqual({ quantity: 500, unit: "g" });
  });

  it("gives the same answer whichever unit of a kind it is entered in", () => {
    // The threshold differs by kind: 1,000 for mass and volume, 100 for length.
    const cases: Array<[NetQuantityUnit, number, number]> = [
      ["g", 1000, 1],
      ["ml", 1000, 1],
      ["cm", 100, 1],
    ];
    for (const [small, threshold, one] of cases) {
      const large = UNIT_SPECS[small].larger!.unit;
      expect(standardQuantityAndUnit(threshold, small)).toEqual(standardQuantityAndUnit(one, large));
      expect(standardQuantityAndUnit(threshold * 1.5, small)).toEqual(
        standardQuantityAndUnit(one * 1.5, large),
      );
      expect(standardQuantityAndUnit(threshold / 2, small)).toEqual(
        standardQuantityAndUnit(one / 2, large),
      );
    }
  });

  it("refuses a quantity it cannot interpret", () => {
    expect(standardQuantityAndUnit(0, "ml")).toBeNull();
    expect(standardQuantityAndUnit(-5, "ml")).toBeNull();
    expect(standardQuantityAndUnit(Number.NaN, "ml")).toBeNull();
    expect(standardQuantityAndUnit(100, null)).toBeNull();
    expect(standardQuantityAndUnit(100, "furlong" as never)).toBeNull();
    expect(standardQuantity(null, "ml")).toBeNull();
  });

  it("labels every standard unit", () => {
    expect(standardUnitLabel("g")).toBe("per g");
    expect(standardUnitLabel("kg")).toBe("per kg");
    expect(standardUnitLabel("ml")).toBe("per ml");
    expect(standardUnitLabel("l")).toBe("per litre");
    expect(standardUnitLabel("cm")).toBe("per cm");
    expect(standardUnitLabel("m")).toBe("per metre");
  });

  it("defines a spec for every unit it accepts", () => {
    for (const [unit, spec] of Object.entries(UNIT_SPECS)) {
      expect(spec.unit).toBe(unit);
      if (spec.larger) {
        expect(spec.larger.basePerOne).toBeGreaterThan(spec.basePerOne);
        expect(spec.larger.fromBaseValue).toBeGreaterThan(0);
      }
    }
  });

  it("recognises count units", () => {
    for (const unit of ["number", "unit", "piece", "pair", "set"]) {
      expect(isCountUnit(unit as never)).toBe(true);
    }
    for (const unit of ["g", "kg", "ml", "l", "cm", "m"]) {
      expect(isCountUnit(unit as never)).toBe(false);
    }
    expect(isCountUnit(null)).toBe(false);
    expect(isCountUnit(undefined)).toBe(false);
  });
});

describe("computeUnitSalePrice", () => {
  it("divides the retail sale price by the standard quantity", () => {
    // ₹300 for 100 ml is ₹3.00 per ml.
    expect(computeUnitSalePrice({ mrp: 300, netQuantityValue: 100, netQuantityUnit: "ml" })).toBe(3);
    // ₹300 for 1,500 ml is ₹200 per litre.
    expect(computeUnitSalePrice({ mrp: 300, netQuantityValue: 1500, netQuantityUnit: "ml" })).toBe(200);
  });

  it("rounds to two decimals, the way Rule 6(11) requires", () => {
    // 100 / 3 = 33.333… → 33.33
    expect(computeUnitSalePrice({ mrp: 100, netQuantityValue: 3, netQuantityUnit: "piece" })).toBe(33.33);
    expect(roundToPaise(1.005)).toBe(1.01);
    expect(roundToPaise(2.675)).toBe(2.68);
  });

  it("returns null when either input is missing or unusable", () => {
    expect(computeUnitSalePrice({ mrp: null, netQuantityValue: 100, netQuantityUnit: "ml" })).toBeNull();
    expect(computeUnitSalePrice({ mrp: 300, netQuantityValue: null, netQuantityUnit: "ml" })).toBeNull();
    expect(computeUnitSalePrice({ mrp: 0, netQuantityValue: 100, netQuantityUnit: "ml" })).toBeNull();
    expect(computeUnitSalePrice({ mrp: 300, netQuantityValue: 0, netQuantityUnit: "ml" })).toBeNull();
  });
});

describe("assessUnitSalePrice", () => {
  it("applies with the expected value and the label for a covered package", () => {
    const assessment = assessUnitSalePrice({
      mrp: 300,
      netQuantityValue: 100,
      netQuantityUnit: "ml",
      packageType: "packaged",
    });
    expect(assessment).toEqual({ applicable: true, expected: 3, label: "per ml", exemption: null });
  });

  it("is exempt where the retail sale price equals the unit sale price", () => {
    const assessment = assessUnitSalePrice({
      mrp: 300,
      netQuantityValue: 1,
      netQuantityUnit: "piece",
      packageType: "packaged",
    });
    expect(assessment.applicable).toBe(false);
    expect(assessment.expected).toBe(300);
    expect(assessment.exemption).toContain("retail sale price equals the unit sale price");
  });

  it("is exempt for wholesale and excluded packages", () => {
    for (const packageType of ["wholesale", "excluded"] as const) {
      const assessment = assessUnitSalePrice({
        mrp: 300,
        netQuantityValue: 100,
        netQuantityUnit: "ml",
        packageType,
      });
      expect(assessment.applicable).toBe(false);
      expect(assessment.expected).toBeNull();
      expect(assessment.exemption).toBeTruthy();
    }
  });

  it("reports no exemption when the quantity cannot be read, so R5 still fails", () => {
    // A missing net quantity is a missing declaration, not an exemption: saying
    // "exempt" here would hide a real gap.
    const assessment = assessUnitSalePrice({
      mrp: 300,
      netQuantityValue: null,
      netQuantityUnit: "ml",
      packageType: "packaged",
    });
    expect(assessment).toEqual({ applicable: false, expected: null, label: null, exemption: null });
  });
});

describe("declared unit sale price", () => {
  it("matches at two decimal places and no tighter", () => {
    expect(declaredUnitSalePriceMatches(3, 3)).toBe(true);
    expect(declaredUnitSalePriceMatches(3.0, 3)).toBe(true);
    expect(declaredUnitSalePriceMatches(3.01, 3)).toBe(false);
    // 33.333 is not 33.33: the pack has to declare the rounded figure.
    expect(declaredUnitSalePriceMatches(33.333, 33.33)).toBe(true);
  });

  it("does not match when either side is missing", () => {
    expect(declaredUnitSalePriceMatches(null, 3)).toBe(false);
    expect(declaredUnitSalePriceMatches(3, null)).toBe(false);
    expect(declaredUnitSalePriceMatches(Number.NaN, 3)).toBe(false);
  });

  it("formats without forcing trailing zeroes", () => {
    expect(formatUnitSalePrice(3)).toBe("3");
    expect(formatUnitSalePrice(3.5)).toBe("3.5");
    expect(formatUnitSalePrice(3.55)).toBe("3.55");
    expect(formatUnitSalePrice(null)).toBe("—");
    expect(formatUnitSalePrice(Number.NaN)).toBe("—");
  });
});

describe("Rule 13 standard-unit correction", () => {
  it("asks for litres at and above 1,000 ml", () => {
    expect(standardUnitCorrection(1000, "ml")).toMatchObject({ requiredUnit: "l", requiredValue: 1 });
    const correction = standardUnitCorrection(1500, "ml")!;
    expect(correction.requiredValue).toBe(1.5);
    expect(correction.message).toContain("1.5 l");
  });

  it("asks for the smaller unit when a large-unit quantity is below the threshold", () => {
    // 0.5 l is 500 ml, and below 1,000 ml the standard unit is ml.
    expect(standardUnitCorrection(0.5, "l")).toMatchObject({ requiredUnit: "ml", requiredValue: 500 });
    expect(standardUnitCorrection(0.5, "l")!.message).toContain("500 ml");
    expect(standardUnitCorrection(0.8, "m")).toMatchObject({ requiredUnit: "cm", requiredValue: 80 });
  });

  it("leaves a compliant declaration alone", () => {
    expect(standardUnitCorrection(500, "ml")).toBeNull();
    expect(standardUnitCorrection(2, "kg")).toBeNull();
    expect(standardUnitCorrection(1.5, "l")).toBeNull();
    expect(standardUnitCorrection(4, "piece")).toBeNull();
  });

  it("refuses an unusable quantity", () => {
    expect(standardUnitCorrection(0, "ml")).toBeNull();
    expect(standardUnitCorrection(-1, "ml")).toBeNull();
    expect(standardUnitCorrection(100, null)).toBeNull();
  });
});
