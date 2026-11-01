/**
 * F3 — every write to a `legal_in.*` metafield goes through here.
 *
 * Responsibilities: validate the patch, diff against the current value, write in
 * batches of 25 with retry, and record one ChangeLog row per field actually
 * written (old value, new value, timestamp, source).
 */
import { validateLegalPatch } from "~/domain/validation";
import type { LegalFields } from "~/domain/types";
import type { Repository } from "~/db/repository";
import type { ChangeLogRow, ShopRecord } from "~/db/types";
import {
  LEGAL_FIELD_TO_METAFIELD,
  LEGAL_NAMESPACE,
  METAFIELD_TYPES,
  type CatalogProduct,
  type MetafieldSetEntry,
  type MetafieldWriteError,
  type MetafieldWriter,
} from "./ports";

export interface LegalUpdate {
  productId: string;
  values: Partial<LegalFields>;
}

export type ChangeSource = "bulk_editor" | "csv_import" | "apply_default" | "install";

export interface ApplyLegalUpdatesOptions {
  shop: ShopRecord;
  repo: Repository;
  writer: MetafieldWriter;
  /** Current catalogue snapshot, used for old values and handle recording. */
  products: CatalogProduct[];
  updates: LegalUpdate[];
  source: ChangeSource;
  now?: Date;
}

export interface ApplyLegalUpdatesResult {
  written: number;
  productsChanged: number;
  errors: MetafieldWriteError[];
  changes: ChangeLogRow[];
  validationErrors: Array<{ productId: string; field: string; message: string }>;
}

export function serialiseMetafieldValue(field: keyof LegalFields, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field === "variantMrp") {
    // The per-variant price map is a JSON metafield; an empty map clears it.
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.length === 0 ? "" : JSON.stringify(value);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return String(value);
}

/** Builds the metafield entries for a patch, skipping values that did not change. */
export function buildLegalMetafieldEntries(
  current: LegalFields,
  values: Partial<LegalFields>,
): MetafieldSetEntry[] {
  const entries: MetafieldSetEntry[] = [];
  for (const [field, value] of Object.entries(values) as Array<[keyof LegalFields, unknown]>) {
    if (value === undefined) continue;
    const next = serialiseMetafieldValue(field, value);
    const before = serialiseMetafieldValue(field, current[field]);
    if (next === before) continue;
    entries.push({
      ownerId: "",
      namespace: LEGAL_NAMESPACE,
      key: LEGAL_FIELD_TO_METAFIELD[field],
      type: METAFIELD_TYPES[LEGAL_FIELD_TO_METAFIELD[field]],
      value: next,
    });
  }
  return entries;
}

export async function applyLegalUpdates(
  options: ApplyLegalUpdatesOptions,
): Promise<ApplyLegalUpdatesResult> {
  const now = options.now ?? new Date();
  const byProduct = new Map(options.products.map((product) => [product.productId, product]));
  const entries: MetafieldSetEntry[] = [];
  const planned: Array<{ product: CatalogProduct; field: keyof LegalFields; next: string; before: string }> = [];
  const validationErrors: ApplyLegalUpdatesResult["validationErrors"] = [];

  for (const update of options.updates) {
    const product = byProduct.get(update.productId);
    if (!product) {
      validationErrors.push({
        productId: update.productId,
        field: "*",
        message: "This product is not in the current catalogue snapshot. Re-run the scan and try again.",
      });
      continue;
    }
    const { values, errors } = validateLegalPatch(update.values, product.legal);
    for (const error of errors) {
      validationErrors.push({ productId: update.productId, field: error.field, message: error.message });
    }
    const entriesForProduct = buildLegalMetafieldEntries(product.legal, values);
    for (const entry of entriesForProduct) {
      entries.push({ ...entry, ownerId: product.productId });
      const field = (Object.keys(LEGAL_FIELD_TO_METAFIELD) as Array<keyof LegalFields>).find(
        (key) => LEGAL_FIELD_TO_METAFIELD[key] === entry.key,
      );
      if (!field) continue;
      planned.push({
        product,
        field,
        next: entry.value,
        before: serialiseMetafieldValue(field, product.legal[field]),
      });
    }
  }

  if (entries.length === 0) {
    return {
      written: 0,
      productsChanged: 0,
      errors: [],
      changes: [],
      validationErrors,
    };
  }

  const result = await options.writer.setMetafields(entries);
  const failedKeys = new Set(result.errors.map((error) => `${error.ownerId}::${error.key}`));

  const changes: ChangeLogRow[] = [];
  for (const item of planned) {
    const key = LEGAL_FIELD_TO_METAFIELD[item.field];
    if (failedKeys.has(`${item.product.productId}::${key}`)) continue;
    changes.push({
      productId: item.product.productId,
      productHandle: item.product.handle,
      field: key,
      oldValue: item.before === "" ? null : item.before,
      newValue: item.next === "" ? null : item.next,
      changedAt: now,
      source: options.source,
    });
  }

  if (changes.length > 0) await options.repo.appendChangeLog(options.shop.id, changes);

  return {
    written: result.written,
    productsChanged: new Set(changes.map((change) => change.productId)).size,
    errors: result.errors,
    changes,
    validationErrors,
  };
}

export interface ApplyDefaultOptions {
  /** Apply to every product of this vendor, or this product type. */
  groupBy: "vendor" | "productType";
  groupValue: string;
  field: keyof LegalFields;
  value: unknown;
  /** When true (the default) only products missing the field are filled. */
  onlyMissing?: boolean;
}

/** "Apply default by vendor or product type" from F3. */
export function buildDefaultUpdates(
  products: CatalogProduct[],
  options: ApplyDefaultOptions,
): LegalUpdate[] {
  const onlyMissing = options.onlyMissing ?? true;
  return products
    .filter((product) => {
      const groupValue = options.groupBy === "vendor" ? product.vendor : product.productType;
      if ((groupValue ?? "") !== options.groupValue) return false;
      if (!onlyMissing) return true;
      const current = product.legal[options.field];
      return current === null || current === undefined || current === "";
    })
    .map((product) => ({
      productId: product.productId,
      values: { [options.field]: options.value } as Partial<LegalFields>,
    }));
}
