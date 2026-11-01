/**
 * Ports between the app's services and Shopify.
 *
 * Every service depends on these interfaces rather than on the Admin API, which
 * is how the scan, the metafield batching and the prior-price publication are
 * integration tested against fakes (and how DEMO_MODE runs with no dev store).
 */
import type { LegalFields } from "~/domain/types";

export interface CatalogVariant {
  variantId: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
}

export interface CatalogProduct {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  variants: CatalogVariant[];
  legal: LegalFields;
  /** True when `legal_in.prior_price` exists and was written after the last price change. */
  priorPricePublished: boolean;
  /**
   * The raw `legal_in.prior_price` metafield value this catalogue read saw, or
   * null when the product has no such metafield. The publisher needs the stored
   * payload to decide whether it is stale (a sale that ended) or already current,
   * without paying for a second read of a metafield the catalogue already has.
   */
  priorPriceMetafield?: string | null;
}

export interface CatalogSource {
  /**
   * The catalogue. `force` bypasses whatever short-lived cache the source keeps;
   * a full read is expensive (one bulk operation), so callers share it by default.
   */
  fetchProducts(options?: { force?: boolean }): Promise<CatalogProduct[]>;
  fetchProduct(productId: string): Promise<CatalogProduct | null>;
  /**
   * Optional targeted read of known products. When a source implements it, the
   * prior-price publisher fetches only the products it is about to write instead
   * of walking the whole catalogue.
   */
  fetchProductsByIds?(productIds: string[]): Promise<CatalogProduct[]>;
  /** Optional: drop a cached catalogue after the app changed product data. */
  invalidate?(): void;
}

export type MetafieldType =
  | "number_decimal"
  | "single_line_text_field"
  | "multi_line_text_field"
  | "boolean"
  | "json";

export interface MetafieldSetEntry {
  ownerId: string;
  namespace: string;
  key: string;
  type: MetafieldType;
  value: string;
}

export interface MetafieldWriteError {
  ownerId: string;
  key: string;
  message: string;
}

export interface MetafieldWriteResult {
  written: number;
  errors: MetafieldWriteError[];
  batches: number;
  retries: number;
}

export interface MetafieldWriter {
  setMetafields(entries: MetafieldSetEntry[]): Promise<MetafieldWriteResult>;
  /**
   * Removes product metafields. Used to clear a `legal_in.prior_price` payload
   * whose sale has ended: writing an empty JSON object still leaves the block a
   * value to render, so the metafield is deleted instead. Implementations without
   * a delete path may fall back to writing an empty value.
   */
  deleteProductMetafields?(keys: Array<{ ownerId: string; namespace: string; key: string }>): Promise<MetafieldWriteResult>;
  /** The shop GID, used as the owner of the shop-level JSON settings metafield. */
  shopOwnerId(): Promise<string>;
}

export const LEGAL_NAMESPACE = "legal_in";

/**
 * The declared package values the app reads from and writes to `legal_in.*`.
 *
 * The set follows the audit's separation of the declaration: manufacturer, packer,
 * importer and seller each have their own fields (L4); the canonical country and
 * the exact label wording are separate (L5); imported-package status is explicit
 * (L6); manufacture/pre-packing and best-before/use-by are separate dates (L9);
 * the common name carries label evidence (L8); unit sale price is its own
 * declaration (L1).
 */
export const LEGAL_METAFIELD_KEYS = [
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

export type LegalMetafieldKey = (typeof LEGAL_METAFIELD_KEYS)[number];

/** Maps the domain field names to the metafield keys written to Shopify. */
export const LEGAL_FIELD_TO_METAFIELD: Record<keyof LegalFields, LegalMetafieldKey> = {
  mrp: "mrp",
  variantMrp: "variant_mrp",
  manufacturerName: "manufacturer_name",
  manufacturerAddress: "manufacturer_address",
  packerDiffersFromManufacturer: "packer_differs_from_manufacturer",
  packerName: "packer_name",
  packerAddress: "packer_address",
  sellerName: "seller_name",
  sellerAddress: "seller_address",
  countryOfOrigin: "country_of_origin",
  countryOfOriginLabel: "country_of_origin_label",
  isImportedPackage: "is_imported_package",
  importerName: "importer_name",
  importerAddress: "importer_address",
  packageType: "package_type",
  netQuantityValue: "net_quantity_value",
  netQuantityUnit: "net_quantity_unit",
  genericName: "generic_name",
  genericNameOnLabel: "generic_name_on_label",
  manufacturedDate: "manufactured_date",
  expiryType: "expiry_type",
  expiryDate: "expiry_date",
  unitSalePrice: "unit_sale_price",
};

export const LEGAL_METAFIELD_TO_FIELD: Record<LegalMetafieldKey, keyof LegalFields> = {
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

/**
 * Metafield keys written by earlier releases. They are still read so an existing
 * store's data is migrated on the next write instead of disappearing, and the
 * importer name/address pair is reconstructed from the old combined
 * `importer_details` value.
 */
export const LEGACY_METAFIELD_KEYS = ["importer_details", "date_type", "date_value"] as const;

export const METAFIELD_TYPES: Record<LegalMetafieldKey, MetafieldType> = {
  mrp: "number_decimal",
  variant_mrp: "json",
  manufacturer_name: "single_line_text_field",
  manufacturer_address: "multi_line_text_field",
  packer_differs_from_manufacturer: "boolean",
  packer_name: "single_line_text_field",
  packer_address: "multi_line_text_field",
  seller_name: "single_line_text_field",
  seller_address: "multi_line_text_field",
  country_of_origin: "single_line_text_field",
  country_of_origin_label: "single_line_text_field",
  is_imported_package: "boolean",
  importer_name: "single_line_text_field",
  importer_address: "multi_line_text_field",
  package_type: "single_line_text_field",
  net_quantity_value: "number_decimal",
  net_quantity_unit: "single_line_text_field",
  generic_name: "single_line_text_field",
  generic_name_on_label: "boolean",
  manufactured_date: "single_line_text_field",
  expiry_type: "single_line_text_field",
  expiry_date: "single_line_text_field",
  unit_sale_price: "number_decimal",
};

export const PRIOR_PRICE_KEY = "prior_price";
export const SHOP_SETTINGS_KEY = "settings";
