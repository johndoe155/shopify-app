/**
 * Catalog reads via a Shopify GraphQL bulk operation (F2).
 *
 * The JSONL parsing is a pure function so the bulk-scan mapping is covered by
 * tests that run a captured bulk-operation payload through it.
 *
 * Every bulk read goes through `BulkOperationCoordinator` (see
 * `bulk-operations.server.ts`): Shopify allows one bulk operation per shop at a
 * time, and this class used to start one per call. Reads of a handful of known
 * products use `nodes(ids:)` instead of a bulk operation, so a webhook never
 * touches the bulk pipeline at all.
 */
import {
  EMPTY_LEGAL_FIELDS,
  PACKAGE_TYPES,
  normaliseQuantityUnit,
  parseLegacyDateFields,
  parseLegacyImporterDetails,
  type ExpiryType,
  type LegalFields,
  type PackageType,
} from "~/domain/types";
import {
  LEGAL_METAFIELD_TO_FIELD,
  PRIOR_PRICE_KEY,
  LEGAL_NAMESPACE,
  type CatalogProduct,
  type CatalogSource,
  type CatalogVariant,
} from "./ports";
import {
  BulkOperationCoordinator,
  PRODUCTS_BY_IDS_QUERY,
  variantFromNode,
  type AdminGraphQL,
  type ProductNode,
} from "./bulk-operations.server";

export { START_BULK_OPERATION, CURRENT_BULK_OPERATION } from "./bulk-operations.server";
export type { BulkOperationState } from "./bulk-operations.server";
export { BulkOperationError } from "./bulk-operations.server";

export const BULK_PRODUCTS_QUERY = `{
  products {
    edges {
      node {
        id
        handle
        title
        vendor
        productType
        status
        updatedAt
        variants {
          edges {
            node {
              id
              title
              price
              compareAtPrice
            }
          }
        }
        metafields(namespace: "${LEGAL_NAMESPACE}") {
          edges {
            node {
              key
              value
              updatedAt
            }
          }
        }
      }
    }
  }
}`;

/** How many product ids one `nodes(ids:)` read asks for. */
export const PRODUCTS_BY_IDS_PAGE = 20;

export const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductForScan($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      vendor
      productType
      status
      variants(first: 100) {
        edges { node { id title price compareAtPrice } }
      }
      metafields(namespace: "${LEGAL_NAMESPACE}", first: 30) {
        edges { node { key value updatedAt } }
      }
    }
  }
`;

interface JsonlMetafield {
  key: string;
  value: string;
}

interface JsonlNode {
  __parentId?: string;
  id?: string;
  handle?: string;
  title?: string;
  vendor?: string | null;
  productType?: string | null;
  status?: string;
  price?: string;
  compareAtPrice?: string | null;
  key?: string;
  value?: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function legalFieldsFromMetafields(metafields: JsonlMetafield[]): LegalFields {
  const byKey = new Map(metafields.map((m) => [m.key, m.value]));
  const fields: LegalFields = { ...EMPTY_LEGAL_FIELDS };

  const asBoolean = (raw: string): boolean | null => {
    const value = raw.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  };

  for (const [key, field] of Object.entries(LEGAL_METAFIELD_TO_FIELD)) {
    const raw = byKey.get(key);
    if (raw === undefined || raw === null || raw === "") continue;

    if (
      field === "mrp" ||
      field === "netQuantityValue" ||
      field === "unitSalePrice"
    ) {
      const parsed = toNumber(raw);
      if (parsed !== null) fields[field] = parsed;
      continue;
    }
    if (field === "variantMrp") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const values: Record<string, number> = {};
          for (const [variantId, amount] of Object.entries(parsed as Record<string, unknown>)) {
            const numeric = toNumber(amount);
            if (numeric !== null) values[variantId] = numeric;
          }
          fields.variantMrp = Object.keys(values).length > 0 ? values : null;
        }
      } catch {
        // A malformed per-variant map is ignored: R1 falls back to the package MRP
        // and the bulk editor rewrites it.
      }
      continue;
    }
    if (field === "netQuantityUnit") {
      const unit = normaliseQuantityUnit(raw);
      if (unit) fields.netQuantityUnit = unit;
      continue;
    }
    if (field === "packageType") {
      const type = raw.trim().toLowerCase();
      if ((PACKAGE_TYPES as readonly string[]).includes(type)) {
        fields.packageType = type as PackageType;
      }
      continue;
    }
    if (field === "expiryType") {
      const type = raw.trim().toLowerCase();
      if (type === "none" || type === "best_before" || type === "use_by") {
        fields.expiryType = type as ExpiryType;
      }
      continue;
    }
    if (
      field === "packerDiffersFromManufacturer" ||
      field === "isImportedPackage"
    ) {
      const parsed = asBoolean(raw);
      if (parsed !== null) fields[field] = parsed;
      continue;
    }
    if (field === "genericNameOnLabel") {
      fields.genericNameOnLabel = asBoolean(raw) === true;
      continue;
    }
    // Remaining fields are plain text.
    (fields as unknown as Record<string, string | null>)[field] = raw;
  }

  // --- legacy keys written by earlier releases -----------------------------
  // Kept readable so a store that installed before this release does not lose
  // its declarations on the next scan; the next write stores the new keys.
  const legacyImporter = parseLegacyImporterDetails(byKey.get("importer_details"));
  if (legacyImporter) {
    if (!fields.importerName && legacyImporter.name) fields.importerName = legacyImporter.name;
    if (!fields.importerAddress && legacyImporter.address) fields.importerAddress = legacyImporter.address;
    // The imported-package flag is not forced to true here. A legacy
    // `importer_details` metafield says an importer was recorded, not that the
    // merchant declared the package imported; R4 infers import status from the
    // country of origin and says in the result that it inferred it.
  }

  const legacyDate = parseLegacyDateFields(byKey.get("date_type"), byKey.get("date_value"));
  if (legacyDate) {
    if (legacyDate.manufacturedDate && !fields.manufacturedDate) {
      fields.manufacturedDate = legacyDate.manufacturedDate;
    }
    if (legacyDate.expiryType !== "none" && legacyDate.expiryDate && !fields.expiryDate) {
      fields.expiryType = legacyDate.expiryType as ExpiryType;
      fields.expiryDate = legacyDate.expiryDate;
    }
  }

  return fields;
}

/**
 * Turns the flattened bulk-operation JSONL into catalog products.
 * Shopify emits one JSON object per line; child connections carry `__parentId`.
 */
export function parseProductJsonl(lines: string[]): CatalogProduct[] {
  const products = new Map<string, CatalogProduct>();
  const variantsByProduct = new Map<string, CatalogVariant[]>();
  const metafieldsByProduct = new Map<string, JsonlMetafield[]>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let node: JsonlNode;
    try {
      node = JSON.parse(line) as JsonlNode;
    } catch {
      continue; // a truncated final line should not fail the whole scan
    }
    if (!node.id) continue;

    if (node.handle !== undefined) {
      products.set(node.id, {
        productId: node.id,
        handle: node.handle,
        title: node.title ?? "",
        vendor: node.vendor ?? null,
        productType: node.productType ?? null,
        status: node.status ?? "ACTIVE",
        variants: [],
        legal: { ...EMPTY_LEGAL_FIELDS },
        priorPricePublished: false,
        priorPriceMetafield: null,
      });
      continue;
    }

    if (node.price !== undefined && node.__parentId) {
      const list = variantsByProduct.get(node.__parentId) ?? [];
      list.push({
        variantId: node.id,
        title: node.title ?? "Default",
        price: toNumber(node.price) ?? 0,
        compareAtPrice: toNumber(node.compareAtPrice),
      });
      variantsByProduct.set(node.__parentId, list);
      continue;
    }

    if (node.key !== undefined && node.__parentId) {
      const list = metafieldsByProduct.get(node.__parentId) ?? [];
      list.push({ key: node.key, value: node.value ?? "" });
      metafieldsByProduct.set(node.__parentId, list);
    }
  }

  return [...products.values()].map((product) => {
    const metafields = metafieldsByProduct.get(product.productId) ?? [];
    const storedPrior = metafields.find((m) => m.key === PRIOR_PRICE_KEY);
    return {
      ...product,
      variants: variantsByProduct.get(product.productId) ?? [],
      legal: legalFieldsFromMetafields(metafields),
      priorPricePublished: storedPrior !== undefined,
      priorPriceMetafield: storedPrior?.value ?? null,
    };
  });
}

/** Maps one `nodes(ids:)` product node into the catalogue shape. */
export function productFromNode(node: ProductNode): CatalogProduct {
  const metafields = node.metafields.edges.map((edge) => edge.node);
  const storedPrior = metafields.find((m) => m.key === PRIOR_PRICE_KEY);
  return {
    productId: node.id,
    handle: node.handle,
    title: node.title,
    vendor: node.vendor,
    productType: node.productType,
    status: node.status,
    variants: node.variants.edges.map((edge) => variantFromNode(edge.node)),
    legal: legalFieldsFromMetafields(metafields),
    priorPricePublished: storedPrior !== undefined,
    priorPriceMetafield: storedPrior?.value ?? null,
  };
}

export interface BulkScanOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a catalogue read is reused by later jobs/requests in this process. */
  cacheTtlMs?: number;
}

export class ShopifyCatalogSource implements CatalogSource {
  private readonly coordinator: BulkOperationCoordinator;

  constructor(
    private readonly admin: AdminGraphQL,
    options: BulkScanOptions = {},
  ) {
    this.coordinator = new BulkOperationCoordinator(admin, parseProductJsonl, BULK_PRODUCTS_QUERY, {
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await this.admin.graphql(query, variables ? { variables } : undefined);
    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) throw new Error("Shopify returned no data for the product query.");
    return body.data;
  }

  /**
   * The whole catalogue. Coalesced with any other in-flight read and reused for
   * `cacheTtlMs`, so a burst of webhooks costs one bulk operation, not one each.
   */
  async fetchProducts(options: { force?: boolean } = {}): Promise<CatalogProduct[]> {
    const read = await this.coordinator.load(options);
    return read.products;
  }

  /**
   * One product by id. Uses a targeted query rather than a bulk operation: a
   * bulk query for a single product both wastes quota and collides with every
   * other catalogue read in the shop.
   */
  async fetchProduct(productId: string): Promise<CatalogProduct | null> {
    const data = await this.graphql<{ product?: ProductNode | null }>(PRODUCT_BY_ID_QUERY, { id: productId });
    return data.product ? productFromNode(data.product) : null;
  }

  /** Many products by id: one request per page, no bulk operation. */
  async fetchProductsByIds(productIds: string[]): Promise<CatalogProduct[]> {
    const unique = [...new Set(productIds.filter(Boolean))];
    const products: CatalogProduct[] = [];
    for (let i = 0; i < unique.length; i += PRODUCTS_BY_IDS_PAGE) {
      const ids = unique.slice(i, i + PRODUCTS_BY_IDS_PAGE);
      const data = await this.graphql<{ nodes?: Array<ProductNode | null> }>(PRODUCTS_BY_IDS_QUERY, { ids });
      for (const node of data.nodes ?? []) {
        if (node && node.id) products.push(productFromNode(node));
      }
    }
    return products;
  }

  /** Drops the cached catalogue (after a write that changed products). */
  invalidate(): void {
    this.coordinator.invalidate();
  }
}
