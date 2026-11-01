import { describe, expect, it } from "vitest";
import { buildChangeLogCsv, buildLegalCsv, buildScanCsv, planCsvImport } from "~/domain/csv";
import { DISCLAIMER } from "~/domain/copy";
import { makeLegalFields, makeProduct } from "./helpers";

const products = [
  {
    handle: "amla-hair-oil-200-ml",
    title: "Amla hair oil 200 ml",
    productType: "Beauty & personal care",
    legal: makeLegalFields(),
  },
  {
    handle: "neem-face-wash-100-ml",
    title: "Neem face wash 100 ml",
    productType: "Beauty & personal care",
    legal: makeLegalFields({ countryOfOrigin: null, mrp: null }),
  },
];

describe("legal CSV export and import", () => {
  it("exports every field with the disclaimer as a comment line", () => {
    const csv = buildLegalCsv(products);
    expect(csv).toContain(`# ${DISCLAIMER}`);
    expect(csv).toContain("handle,title,product_type,mrp");
    expect(csv).toContain("amla-hair-oil-200-ml");
    expect(csv).toContain("India");
    // The separated declarations are their own columns (audit items L1, L4-L9).
    for (const column of [
      "variant_mrp",
      "packer_differs_from_manufacturer",
      "packer_name",
      "seller_name",
      "country_of_origin_label",
      "is_imported_package",
      "importer_name",
      "importer_address",
      "package_type",
      "generic_name_on_label",
      "manufactured_date",
      "expiry_type",
      "expiry_date",
      "unit_sale_price",
    ]) {
      expect(csv).toContain(column);
    }
    expect(csv).not.toContain("importer_details");
    expect(csv).not.toContain("date_type");
  });

  it("round trips an exported file with no changes", () => {
    const csv = buildLegalCsv(products);
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    expect(preview.summary.productsToChange).toBe(0);
    expect(preview.summary.productsUnchanged).toBe(2);
  });

  it("detects a change and matches on handle", () => {
    const csv = [
      "handle,mrp,country_of_origin",
      "amla-hair-oil-200-ml,300,India",
      "neem-face-wash-100-ml,199,India",
    ].join("\n");
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    expect(preview.summary.productsToChange).toBe(1);
    expect(preview.summary.productsUnchanged).toBe(1);
    const row = preview.rows.find((candidate) => candidate.handle === "neem-face-wash-100-ml")!;
    expect(row.values.mrp).toBe(199);
    expect(row.values.countryOfOrigin).toBe("India");
    expect(preview.summary.changesByField.map((entry) => entry.field).sort()).toEqual([
      "country_of_origin",
      "mrp",
    ]);
  });

  it("leaves blank cells unchanged instead of clearing data", () => {
    const csv = `handle,mrp,country_of_origin\namla-hair-oil-200-ml,,\n`;
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    // Nothing to write for this row, so it is counted as unchanged and no patch is produced.
    expect(preview.rows).toEqual([]);
    expect(preview.summary.productsUnchanged).toBe(1);
    expect(preview.summary.productsToChange).toBe(0);
  });

  it("reports an unknown handle with its row number", () => {
    const csv = `handle,mrp\nnot-a-real-handle,199\n`;
    const preview = planCsvImport(csv, products);
    expect(preview.rows).toHaveLength(0);
    expect(preview.errors[0]).toMatchObject({ rowNumber: 2, handle: "not-a-real-handle", field: "handle" });
  });

  it("rejects invalid values per row and keeps the valid rows", () => {
    const csv = `handle,mrp,net_quantity_unit,expiry_type,expiry_date\namla-hair-oil-200-ml,abc,grams,best_before,2026-03\nneem-face-wash-100-ml,199,g,best_before,03/2026\n`;
    const preview = planCsvImport(csv, products);
    const invalidRow = preview.errors.filter((error) => error.handle === "amla-hair-oil-200-ml");
    expect(invalidRow.map((error) => error.field).sort()).toEqual(["expiry_date", "mrp", "net_quantity_unit"]);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.handle).toBe("neem-face-wash-100-ml");
  });

  it("still imports a file exported by the previous release", () => {
    // Audit-driven upgrade: `importer_details` and `date_type`/`date_value` are
    // gone, but a spreadsheet exported before this release still opens.
    const csv = [
      "handle,importer_details,date_type,date_value",
      "amla-hair-oil-200-ml,\"Aranya Imports Pvt Ltd, MG Road, Mumbai 400001\",manufactured,03/2026",
    ].join("\n");
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    const row = preview.rows[0]!;
    expect(row.values.importerName).toBe("Aranya Imports Pvt Ltd");
    expect(row.values.importerAddress).toBe("MG Road, Mumbai 400001");
    // The flag is not forced: an old importer cell is not a declaration that the
    // package is imported, and R4 infers status from the country and says so.
    expect(row.values.isImportedPackage).toBeUndefined();
    expect(row.values.manufacturedDate).toBe("03/2026");
  });

  it("reads a legacy date_value with no date_type as the manufacture date", () => {
    // The previous release wrote date_type="none" (and sometimes left it blank)
    // for a manufacture date. The scan path always read it that way; now the
    // import path does too, so the two agree.
    for (const dateType of ["none", ""]) {
      const csv = [
        "handle,date_type,date_value",
        `amla-hair-oil-200-ml,${dateType},03/2026`,
      ].join("\n");
      const preview = planCsvImport(csv, products);
      expect(preview.errors).toEqual([]);
      expect(preview.rows[0]!.values.manufacturedDate).toBe("03/2026");
    }
  });

  it("accepts a currency symbol and thousands separators in MRP", () => {
    const csv = `handle,mrp\namla-hair-oil-200-ml,"₹1,299.50"\n`;
    const preview = planCsvImport(csv, products);
    expect(preview.rows[0]!.values.mrp).toBe(1299.5);
  });

  it("tolerates a byte-order mark and Windows line endings", () => {
    const csv = `\uFEFFhandle,mrp\r\namla-hair-oil-200-ml,275\r\n`;
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0]!.values.mrp).toBe(275);
  });

  it("reports an empty file rather than pretending it succeeded", () => {
    const preview = planCsvImport("handle,mrp\n", products);
    expect(preview.summary.totalRows).toBe(0);
    expect(preview.errors.length).toBeGreaterThan(0);
  });
});

describe("evidence CSV exports", () => {
  it("scan CSV has one row per product, the per-rule columns and the disclaimer", () => {
    const csv = buildScanCsv(
      [
        {
          productId: "1",
          handle: "a",
          title: "A",
          vendor: "V",
          productType: "T",
          passing: false,
          failingRuleIds: ["R1", "R6"],
          ruleStatuses: { R1: "fail", R6: "fail", R3: "pass" },
          scannedAt: new Date("2026-10-30T10:00:00.000Z"),
        },
      ],
      ["R1", "R3", "R6"],
    );
    const lines = csv.split("\n");
    expect(lines[0]).toContain("not legal advice");
    expect(lines[1]).toContain("Exported");
    expect(lines[2]).toContain("product_id,handle,title");
    expect(lines[3]).toContain("fail");
    expect(lines[3]).toContain("R1 R6");
    expect(lines[3]).toContain("30 Oct 2026");
  });

  it("change log CSV carries old value, new value and timestamp", () => {
    const csv = buildChangeLogCsv([
      {
        productId: "1",
        handle: "a",
        field: "mrp",
        oldValue: null,
        newValue: "249.00",
        changedAt: new Date("2026-10-30T10:00:00.000Z"),
        source: "bulk_editor",
      },
    ]);
    expect(csv).toContain("old_value,new_value,changed_at");
    expect(csv).toContain("249.00");
    expect(csv).toContain("bulk_editor");
    expect(csv).toContain("not legal advice");
  });
});

describe("csv helpers used by the editor", () => {
  it("ignores extra columns in the import file", () => {
    const csv = `handle,title,mrp,some_other_column\namla-hair-oil-200-ml,Amla,299,whatever\n`;
    const preview = planCsvImport(csv, products);
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0]!.values.mrp).toBe(299);
  });

  it("treats a product built by the factory the same way as a catalogue row", () => {
    const product = makeProduct();
    const preview = planCsvImport(`handle,mrp\n${product.handle},100\n`, [
      { handle: product.handle, title: product.title, productType: product.productType, legal: product.legal },
    ]);
    expect(preview.summary.productsToChange).toBe(1);
  });
});
