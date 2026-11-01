/**
 * Unit sale price and net-quantity standard units (audit items L1, L7, R13/R5).
 *
 * The audit is explicit about two things this file now owns:
 *
 *  - Rule 6(11) requires the unit sale price **in the applicable standard unit**,
 *    rounded to the nearest two decimal places. "Two decimal places" means
 *    rounded to two decimals, not that trailing zeroes must be printed.
 *  - Rule 13 supplies the threshold logic that turns a quantity into the
 *    standard unit: grams up to 1,000 g then kilograms, centimetres up to 100 cm
 *    then metres, millilitres up to 1,000 ml then litres, and the permitted count
 *    descriptors (number, unit, piece, pair, set) where the commodity is sold by
 *    number.
 *
 * Nothing here claims a statutory exemption that the audit did not establish.
 * The only exclusions modelled are the ones the audit names: retail sale price
 * equal to the unit sale price, and the Rules 3/26 package scope that the
 * merchant marks on the product (`packageType`).
 */
import type { NetQuantityUnit, PackageType } from "./types";

export type QuantityKind = "mass" | "length" | "volume" | "count";

export interface UnitSpec {
  unit: NetQuantityUnit;
  kind: QuantityKind;
  /** How many base units of the kind this unit holds (g, cm, ml, or one item). */
  basePerOne: number;
  /**
   * The larger unit that becomes standard at or above `fromBaseValue` base
   * units, and how many base units that larger unit holds.
   */
  larger: { unit: NetQuantityUnit; fromBaseValue: number; basePerOne: number } | null;
}

/**
 * Rule 13 unit vocabulary. `piece` replaces the legacy `pcs` spelling; the
 * parser normalises the old value so existing metafields keep working.
 */
export const UNIT_SPECS: Record<NetQuantityUnit, UnitSpec> = {
  g: { unit: "g", kind: "mass", basePerOne: 1, larger: { unit: "kg", fromBaseValue: 1000, basePerOne: 1000 } },
  kg: { unit: "kg", kind: "mass", basePerOne: 1000, larger: null },
  ml: { unit: "ml", kind: "volume", basePerOne: 1, larger: { unit: "l", fromBaseValue: 1000, basePerOne: 1000 } },
  l: { unit: "l", kind: "volume", basePerOne: 1000, larger: null },
  cm: { unit: "cm", kind: "length", basePerOne: 1, larger: { unit: "m", fromBaseValue: 100, basePerOne: 100 } },
  m: { unit: "m", kind: "length", basePerOne: 100, larger: null },
  number: { unit: "number", kind: "count", basePerOne: 1, larger: null },
  unit: { unit: "unit", kind: "count", basePerOne: 1, larger: null },
  piece: { unit: "piece", kind: "count", basePerOne: 1, larger: null },
  pair: { unit: "pair", kind: "count", basePerOne: 2, larger: null },
  set: { unit: "set", kind: "count", basePerOne: 1, larger: null },
};

const COUNT_UNITS: readonly NetQuantityUnit[] = ["number", "unit", "piece", "pair", "set"];

export function isCountUnit(unit: NetQuantityUnit | null | undefined): boolean {
  return unit !== null && unit !== undefined && COUNT_UNITS.includes(unit);
}

/** Human label for the standard unit the price is quoted per. */
export function standardUnitLabel(unit: NetQuantityUnit): string {
  switch (unit) {
    case "g":
      return "per g";
    case "kg":
      return "per kg";
    case "ml":
      return "per ml";
    case "l":
      return "per litre";
    case "cm":
      return "per cm";
    case "m":
      return "per metre";
    default:
      return `per ${unit}`;
  }
}

/**
 * The base spec (g, ml, cm) for every mass, volume and length unit.
 *
 * The threshold that decides the standard unit lives on the *base* spec, so a
 * quantity typed in the larger unit has to be resolved back to it: 2 kg and
 * 2,000 g are the same quantity and must both end up as "2 kg". Reading the
 * threshold from the unit as typed only worked in one direction.
 */
const BASE_SPEC_BY_UNIT: Partial<Record<NetQuantityUnit, UnitSpec>> = (() => {
  const specs = Object.values(UNIT_SPECS);
  const map: Partial<Record<NetQuantityUnit, UnitSpec>> = {};
  for (const spec of specs) {
    if (spec.kind === "count") continue;
    const base = specs.find((candidate) => candidate.kind === spec.kind && candidate.basePerOne === 1);
    if (base) map[spec.unit] = base;
  }
  return map;
})();

/**
 * The quantity in the Rule 13 standard unit **and** the unit itself.
 *
 * The threshold decides the unit, so the two must be produced together: 500 ml is
 * declared per ml, 1,500 ml is declared per litre, and a label that said "per
 * litre" next to a millilitre quantity would be wrong by a factor of 1,000. The
 * threshold is applied to the quantity whatever unit it was entered in, so a
 * merchant who types "2 kg" is not asked to declare a price "per gram".
 */
export function standardQuantityAndUnit(
  value: number | null | undefined,
  unit: NetQuantityUnit | null | undefined,
): { quantity: number; unit: NetQuantityUnit } | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (!unit || !(unit in UNIT_SPECS)) return null;
  const spec = UNIT_SPECS[unit];
  if (spec.kind === "count") return { quantity: value, unit };
  const baseSpec = BASE_SPEC_BY_UNIT[unit]!;
  const baseQuantity = value * spec.basePerOne;
  const larger = baseSpec.larger;
  if (larger && baseQuantity >= larger.fromBaseValue) {
    return { quantity: roundToPaise(baseQuantity / larger.basePerOne), unit: larger.unit };
  }
  return { quantity: roundToPaise(baseQuantity), unit: baseSpec.unit };
}

/**
 * The quantity expressed in the standard unit for that kind: kg, litre, metre or
 * a number of items. `null` when the quantity cannot be interpreted.
 */
export function standardQuantity(
  value: number | null | undefined,
  unit: NetQuantityUnit | null | undefined,
): number | null {
  return standardQuantityAndUnit(value, unit)?.quantity ?? null;
}

/** Rounds to the nearest two decimal places, the way Rule 6(11) requires. */
export function roundToPaise(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The unit sale price the pack should declare: retail sale price divided by the
 * standard quantity. `null` when MRP or net quantity is missing/unusable.
 */
export function computeUnitSalePrice(input: {
  mrp: number | null | undefined;
  netQuantityValue: number | null | undefined;
  netQuantityUnit: NetQuantityUnit | null | undefined;
}): number | null {
  const standard = standardQuantityAndUnit(input.netQuantityValue, input.netQuantityUnit);
  if (!standard || standard.quantity <= 0) return null;
  if (typeof input.mrp !== "number" || !Number.isFinite(input.mrp) || input.mrp <= 0) return null;
  return roundToPaise(input.mrp / standard.quantity);
}

export interface UnitSalePriceAssessment {
  applicable: boolean;
  /** What the pack should declare, when the app can work it out. */
  expected: number | null;
  label: string | null;
  /** Why the declaration is not required, when it is not. */
  exemption: string | null;
}

/**
 * Whether Rule 6(11) applies to this package, and what it should say.
 *
 * Exemptions modelled (all from the audit, none invented):
 *  - the merchant has marked the package outside Rules 3/26 scope
 *    (`packageType` wholesale or excluded);
 *  - the retail sale price equals the unit sale price (Rule 6(11) proviso), which
 *    in practice is a one-unit package where the computed value equals the MRP;
 *  - the net quantity cannot be interpreted, so no unit price can be computed —
 *    that is reported by R5, not silently treated as an exemption.
 */
export function assessUnitSalePrice(input: {
  mrp: number | null | undefined;
  netQuantityValue: number | null | undefined;
  netQuantityUnit: NetQuantityUnit | null | undefined;
  packageType: PackageType;
}): UnitSalePriceAssessment {
  if (input.packageType === "excluded") {
    return {
      applicable: false,
      expected: null,
      label: null,
      exemption: "this package is marked as outside the Rules 3 and 26 scope",
    };
  }
  if (input.packageType === "wholesale") {
    return {
      applicable: false,
      expected: null,
      label: null,
      exemption: "wholesale packages are outside the retail declaration regime",
    };
  }
  const expected = computeUnitSalePrice(input);
  if (expected === null) {
    return { applicable: false, expected: null, label: null, exemption: null };
  }
  const standard = standardQuantityAndUnit(input.netQuantityValue, input.netQuantityUnit);
  const label = standard ? standardUnitLabel(standard.unit) : null;
  // "It does not apply where the retail sale price equals the unit sale price."
  const equalsRetailPrice =
    typeof input.mrp === "number" && roundToPaise(input.mrp) === roundToPaise(expected);
  return {
    applicable: !equalsRetailPrice,
    expected,
    label,
    exemption: equalsRetailPrice ? "the retail sale price equals the unit sale price" : null,
  };
}

/** True when a declared unit sale price matches the computed one at 2 dp. */
export function declaredUnitSalePriceMatches(
  declared: number | null | undefined,
  expected: number | null,
): boolean {
  if (typeof declared !== "number" || !Number.isFinite(declared)) return false;
  if (expected === null) return false;
  return roundToPaise(declared) === roundToPaise(expected);
}

/** Formatting for UI and exports: up to two decimals, no forced trailing zeroes. */
export function formatUnitSalePrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = roundToPaise(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
}

/**
 * Rule 13 threshold check: is the declared net quantity already expressed in the
 * standard unit? Returns the corrected declaration when it is not.
 */
export function standardUnitCorrection(
  value: number | null | undefined,
  unit: NetQuantityUnit | null | undefined,
): { requiredUnit: NetQuantityUnit; requiredValue: number; message: string } | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (!unit || !(unit in UNIT_SPECS)) return null;
  const standard = standardQuantityAndUnit(value, unit);
  if (!standard || standard.unit === unit) return null; // already the standard unit
  const baseSpec = BASE_SPEC_BY_UNIT[unit]!;
  if (standard.unit === baseSpec.unit) {
    // Below the threshold: 0.5 l has to be declared as 500 ml.
    return {
      requiredUnit: baseSpec.unit,
      requiredValue: standard.quantity,
      message: `Declare the net quantity as ${standard.quantity} ${baseSpec.unit} rather than ${value} ${unit}: Rule 13 uses ${baseSpec.unit} as the standard unit below ${baseSpec.larger!.fromBaseValue} ${baseSpec.unit}.`,
    };
  }
  return {
    requiredUnit: standard.unit,
    requiredValue: standard.quantity,
    message: `Declare the net quantity as ${standard.quantity} ${standard.unit} rather than ${value} ${unit}: Rule 13 uses ${standard.unit} as the standard unit at and above ${baseSpec.larger!.fromBaseValue} ${baseSpec.unit}.`,
  };
}

/**
 * The count descriptors Rule 13 allows. Exposed for the help page and the
 * metafield definition's choice list so the UI and the storefront agree.
 */
export const QUANTITY_KIND_LABELS: Record<QuantityKind, string> = {
  mass: "weight (g up to 1,000 g, then kg)",
  length: "length (cm up to 100 cm, then m)",
  volume: "volume (ml up to 1,000 ml, then l)",
  count: "number (number, unit, piece, pair, set)",
};
