/**
 * CSV export and import (F3, F8).
 *
 * Round trip: export -> edit -> import, matched on product handle. Export files
 * start with `#` comment lines carrying the disclaimer; the importer ignores
 * any line that starts with `#`, so a file exported by the app re-imports
 * unchanged.
 */
import Papa from "papaparse";
import { DISCLAIMER, formatDateTime } from "./copy";
import { validateLegalPatch, type FieldError } from "./validation";
import { parseLegacyDateFields, parseLegacyImporterDetails, type LegalFields } from "./types";

export const DISCLAIMER_LINE = `# ${DISCLAIMER}`;

/**
 * Export columns. The set follows the audit's separation of the declaration, so a
 * merchant editing a spreadsheet sees the same fields the checks use: manufacturer,
 * packer, importer and seller apart (L4); canonical country and label wording apart
 * (L5); an explicit imported-package flag (L6); manufacture and best-before/use-by
 * dates apart (L9); label evidence for the common name (L8); unit sale price (L1).
 */
const LEGAL_COLUMNS = [
  "handle",
  "title",
  "product_type",
  "mrp",
  "variant_mrp",
  "manufacturer_name",
  "manufacturer_address",
  "packer_differs_from_manufacturer",
  "packer_name",
  "packer_address",
  "seller_name",
  "seller_address",
  "country_of_origin",
  "country_of_origin_label",
  "is_imported_package",
  "importer_name",
  "importer_address",
  "package_type",
  "net_quantity_value",
  "net_quantity_unit",
  "generic_name",
  "generic_name_on_label",
  "manufactured_date",
  "expiry_type",
  "expiry_date",
  "unit_sale_price",
] as const;

export const LEGAL_IMPORT_FIELDS = [
  "mrp",
  "variant_mrp",
  "manufacturer_name",
  "manufacturer_address",
  "packer_differs_from_manufacturer",
  "packer_name",
  "packer_address",
  "seller_name",
  "seller_address",
  "country_of_origin",
  "country_of_origin_label",
  "is_imported_package",
  "importer_name",
  "importer_address",
  "package_type",
  "net_quantity_value",
  "net_quantity_unit",
  "generic_name",
  "generic_name_on_label",
  "manufactured_date",
  "expiry_type",
  "expiry_date",
  "unit_sale_price",
] as const;

export interface LegalCsvProduct {
  handle: string;
  title: string;
  productType: string | null;
  legal: LegalFields;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function withHeader(lines: string[][], comment: string[]): string {
  const csv = Papa.unparse(lines, { quotes: false, newline: "\n" });
  return [...comment, csv].join("\n") + "\n";
}

/** Export of the current legal fields, ready to edit and re-import. */
export function buildLegalCsv(products: LegalCsvProduct[], now: Date = new Date()): string {
  const rows: string[][] = [[...LEGAL_COLUMNS]];
  for (const product of products) {
    rows.push([
      product.handle,
      product.title,
      cell(product.productType),
      cell(product.legal.mrp),
      cell(product.legal.variantMrp === null ? null : JSON.stringify(product.legal.variantMrp)),
      cell(product.legal.manufacturerName),
      cell(product.legal.manufacturerAddress),
      cell(product.legal.packerDiffersFromManufacturer === null ? "" : String(product.legal.packerDiffersFromManufacturer)),
      cell(product.legal.packerName),
      cell(product.legal.packerAddress),
      cell(product.legal.sellerName),
      cell(product.legal.sellerAddress),
      cell(product.legal.countryOfOrigin),
      cell(product.legal.countryOfOriginLabel),
      cell(product.legal.isImportedPackage === null ? "" : String(product.legal.isImportedPackage)),
      cell(product.legal.importerName),
      cell(product.legal.importerAddress),
      cell(product.legal.packageType),
      cell(product.legal.netQuantityValue),
      cell(product.legal.netQuantityUnit),
      cell(product.legal.genericName),
      String(product.legal.genericNameOnLabel),
      cell(product.legal.manufacturedDate),
      cell(product.legal.expiryType),
      cell(product.legal.expiryDate),
      cell(product.legal.unitSalePrice),
    ]);
  }
  return withHeader(rows, [DISCLAIMER_LINE, `# Exported ${formatDateTime(now)}`]);
}

export interface CsvRowError extends FieldError {
  rowNumber: number;
  handle: string | null;
}

export interface LegalCsvRow {
  rowNumber: number;
  handle: string;
  values: Partial<LegalFields>;
}

export interface CsvImportPreview {
  rows: LegalCsvRow[];
  errors: CsvRowError[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    productsToChange: number;
    productsUnchanged: number;
    changesByField: Array<{ field: string; count: number }>;
  };
}

function stripComments(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const CSV_TO_LEGAL_KEY: Record<string, keyof LegalFields> = {
  mrp: "mrp",
  variant_mrp: "variantMrp",
  manufacturer_name: "manufacturerName",
  manufacturer_address: "manufacturerAddress",
  packer_differs_from_manufacturer: "packerDiffersFromManufacturer",
  packer_name: "packerName",
  packer_address: "packerAddress",
  seller_name: "sellerName",
  seller_address: "sellerAddress",
  country_of_origin: "countryOfOrigin",
  country_of_origin_label: "countryOfOriginLabel",
  is_imported_package: "isImportedPackage",
  importer_name: "importerName",
  importer_address: "importerAddress",
  package_type: "packageType",
  net_quantity_value: "netQuantityValue",
  net_quantity_unit: "netQuantityUnit",
  generic_name: "genericName",
  generic_name_on_label: "genericNameOnLabel",
  manufactured_date: "manufacturedDate",
  expiry_type: "expiryType",
  expiry_date: "expiryDate",
  unit_sale_price: "unitSalePrice",
};

function sameValue(a: unknown, b: unknown): boolean {
  const normalise = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v).trim());
  if (normalise(a) === normalise(b)) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && normalise(a) !== null && normalise(b) !== null) {
    return Math.abs(na - nb) < 1e-9;
  }
  return false;
}

/**
 * Parses an import file and diffs it against current values.
 * Nothing is written here — the caller shows this preview first.
 */
export function planCsvImport(
  csvText: string,
  existing: LegalCsvProduct[],
): CsvImportPreview {
  const byHandle = new Map(existing.map((p) => [p.handle.toLowerCase(), p]));
  const parsed = Papa.parse<Record<string, string>>(stripComments(csvText), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const errors: CsvRowError[] = [];
  const rows: LegalCsvRow[] = [];
  const changesByField = new Map<string, number>();
  let productsChanged = 0;
  let productsUnchanged = 0;

  if (parsed.data.length === 0) {
    errors.push({ rowNumber: 0, handle: null, field: "file", message: "The file has no data rows." });
    return {
      rows,
      errors,
      summary: {
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        productsToChange: 0,
        productsUnchanged: 0,
        changesByField: [],
      },
    };
  }

  parsed.data.forEach((raw, index) => {
    const rowNumber = index + 2; // +1 for zero-based, +1 for the header row
    const handle = (raw["handle"] ?? "").trim();
    if (!handle) {
      errors.push({ rowNumber, handle: null, field: "handle", message: "Missing product handle." });
      return;
    }
    const current = byHandle.get(handle.toLowerCase());
    if (!current) {
      errors.push({
        rowNumber,
        handle,
        field: "handle",
        message: `No product in this store has the handle "${handle}".`,
      });
      return;
    }

    // Map legacy columns onto the current field set first, so a spreadsheet
    // exported before this release still imports without manual editing.
    // Same helpers the scan uses, so an old spreadsheet reads the same way in
    // both paths (previously they disagreed about `date_type=none`).
    const legacyImporter = parseLegacyImporterDetails(raw["importer_details"]);
    if (legacyImporter && !(raw["importer_name"] ?? "").trim() && !(raw["importer_address"] ?? "").trim()) {
      if (legacyImporter.name) raw["importer_name"] = legacyImporter.name;
      if (legacyImporter.address) raw["importer_address"] = legacyImporter.address;
      // The imported-package flag is deliberately left alone. An `importer_details`
      // cell is evidence that an importer was recorded, not a merchant's
      // declaration that the package is imported; forcing the flag to true made
      // R4 report an inference as if the merchant had recorded it.
    }
    const legacyDate = parseLegacyDateFields(raw["date_type"], raw["date_value"]);
    if (legacyDate && !(raw["manufactured_date"] ?? "").trim() && !(raw["expiry_date"] ?? "").trim()) {
      if (legacyDate.expiryType !== "none" && legacyDate.expiryDate) {
        raw["expiry_type"] = legacyDate.expiryType;
        raw["expiry_date"] = legacyDate.expiryDate;
      } else if (legacyDate.manufacturedDate) {
        raw["manufactured_date"] = legacyDate.manufacturedDate;
      }
    }

    const patchInput: Record<string, unknown> = {};
    const present: string[] = [];
    for (const [column, key] of Object.entries(CSV_TO_LEGAL_KEY)) {
      if (!(column in raw)) continue;
      const value = raw[column];
      // Blank cells mean "leave unchanged" rather than "clear", which keeps a
      // partial import from wiping data the merchant did not touch.
      if (value === undefined || value === null || String(value).trim() === "") continue;
      patchInput[key] = value;
      present.push(column);
    }

    if (present.length === 0) {
      productsUnchanged += 1;
      return;
    }

    const { values, errors: fieldErrors } = validateLegalPatch(patchInput, current.legal);
    if (fieldErrors.length > 0) {
      for (const fieldError of fieldErrors) {
        const column =
          Object.entries(CSV_TO_LEGAL_KEY).find(([, key]) => key === fieldError.field)?.[0] ?? fieldError.field;
        errors.push({ ...fieldError, field: column, rowNumber, handle });
      }
      return;
    }

    let changedHere = 0;
    for (const [key, value] of Object.entries(values) as Array<[keyof LegalFields, unknown]>) {
      if (!sameValue(value, current.legal[key])) {
        changedHere += 1;
        const column = Object.entries(CSV_TO_LEGAL_KEY).find(([, k]) => k === key)?.[0] ?? key;
        changesByField.set(column, (changesByField.get(column) ?? 0) + 1);
      }
    }
    if (changedHere > 0) productsChanged += 1;
    else productsUnchanged += 1;

    rows.push({ rowNumber, handle: current.handle, values });
  });

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors.slice(0, 20)) {
      errors.push({
        rowNumber: (error.row ?? 0) + 2,
        handle: null,
        field: "file",
        message: `The file could not be read at this row: ${error.message}`,
      });
    }
  }

  return {
    rows,
    errors,
    summary: {
      totalRows: parsed.data.length,
      validRows: rows.length,
      invalidRows: parsed.data.length - rows.length,
      productsToChange: productsChanged,
      productsUnchanged,
      changesByField: [...changesByField.entries()]
        .map(([field, count]) => ({ field, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence exports (F8)
// ---------------------------------------------------------------------------

export interface ScanExportRow {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  passing: boolean;
  /** Rolled-up status; falls back to `passing` when a caller does not set it. */
  status?: "pass" | "fail" | "inconclusive";
  failingRuleIds: string[];
  /** Rule ids whose check could not be verified (never counted as failures). */
  inconclusiveRuleIds?: string[];
  ruleStatuses: Record<string, string>;
  scannedAt: Date;
}

export function buildScanCsv(rows: ScanExportRow[], ruleIds: string[], now: Date = new Date()): string {
  const header = [
    "product_id",
    "handle",
    "title",
    "vendor",
    "product_type",
    "result",
    "failing_rules",
    ...ruleIds,
    "scanned_at",
  ];
  const lines: string[][] = [header];
  for (const row of rows) {
    lines.push([
      row.productId,
      row.handle,
      row.title,
      cell(row.vendor),
      cell(row.productType),
      row.status === "fail" || (row.status === undefined && !row.passing)
        ? "checks failing"
        : row.status === "inconclusive"
          ? "a check could not be verified"
          : "all checks pass",
      row.failingRuleIds.join(" "),
      ...ruleIds.map((ruleId) => row.ruleStatuses[ruleId] ?? ""),
      formatDateTime(row.scannedAt),
    ]);
  }
  return withHeader(lines, [DISCLAIMER_LINE, `# Exported ${formatDateTime(now)}`]);
}

export interface ChangeLogExportRow {
  productId: string;
  handle: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  source: string;
}

export function buildChangeLogCsv(rows: ChangeLogExportRow[], now: Date = new Date()): string {
  const lines: string[][] = [["product_id", "handle", "field", "old_value", "new_value", "changed_at", "source"]];
  for (const row of rows) {
    lines.push([
      row.productId,
      cell(row.handle),
      row.field,
      cell(row.oldValue),
      cell(row.newValue),
      formatDateTime(row.changedAt),
      row.source,
    ]);
  }
  return withHeader(lines, [DISCLAIMER_LINE, `# Exported ${formatDateTime(now)}`]);
}
