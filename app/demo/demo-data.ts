/**
 * Deterministic demo catalogue used by DEMO_MODE (and by the screenshot script).
 *
 * It is deliberately imperfect: a realistic D2C catalogue where roughly 40% of
 * products are missing at least one declaration, some products are imported, and
 * only some carry a date. That is what the dashboard, bulk editor and exports
 * look like for a real merchant on day one.
 */
import { EMPTY_LEGAL_FIELDS, type ExpiryType, type LegalFields, type NetQuantityUnit } from "~/domain/types";
import { computeUnitSalePrice } from "~/domain/unit-price";
import type { CatalogProduct } from "~/services/ports";

export type DemoCategory = "Beauty & personal care" | "Food & wellness" | "Home & kitchen" | "Accessories" | "Small electronics";

interface DemoItem {
  category: DemoCategory;
  name: string;
  unit: NetQuantityUnit;
  size: number;
  base: number;
  dateSensitive: boolean;
}

const ITEMS: DemoItem[] = [
  { category: "Beauty & personal care", name: "Neem face wash", unit: "ml", size: 100, base: 249, dateSensitive: true },
  { category: "Beauty & personal care", name: "Amla hair oil", unit: "ml", size: 200, base: 349, dateSensitive: true },
  { category: "Beauty & personal care", name: "Sandalwood face pack", unit: "g", size: 100, base: 399, dateSensitive: true },
  { category: "Beauty & personal care", name: "Rose water toner", unit: "ml", size: 120, base: 199, dateSensitive: true },
  { category: "Beauty & personal care", name: "Kumkumadi serum", unit: "ml", size: 30, base: 899, dateSensitive: true },
  { category: "Beauty & personal care", name: "Aloe vera gel", unit: "g", size: 150, base: 275, dateSensitive: true },
  { category: "Beauty & personal care", name: "Ubtan body scrub", unit: "g", size: 200, base: 449, dateSensitive: true },
  { category: "Beauty & personal care", name: "Coconut lip balm", unit: "g", size: 8, base: 149, dateSensitive: false },
  { category: "Food & wellness", name: "Cold pressed coconut oil", unit: "l", size: 1, base: 599, dateSensitive: true },
  { category: "Food & wellness", name: "Turmeric latte mix", unit: "g", size: 150, base: 379, dateSensitive: true },
  { category: "Food & wellness", name: "A2 cow ghee", unit: "ml", size: 500, base: 949, dateSensitive: true },
  { category: "Food & wellness", name: "Millet muesli", unit: "g", size: 400, base: 429, dateSensitive: true },
  { category: "Food & wellness", name: "Himalayan pink salt", unit: "g", size: 500, base: 179, dateSensitive: false },
  { category: "Food & wellness", name: "Assam green tea", unit: "g", size: 100, base: 329, dateSensitive: true },
  { category: "Food & wellness", name: "Chyawanprash", unit: "g", size: 500, base: 465, dateSensitive: true },
  { category: "Food & wellness", name: "Peanut chikki", unit: "g", size: 250, base: 149, dateSensitive: true },
  { category: "Home & kitchen", name: "Cast iron tawa", unit: "piece", size: 1, base: 1299, dateSensitive: false },
  { category: "Home & kitchen", name: "Copper water bottle", unit: "piece", size: 1, base: 899, dateSensitive: false },
  { category: "Home & kitchen", name: "Bamboo cutting board", unit: "piece", size: 1, base: 649, dateSensitive: false },
  { category: "Home & kitchen", name: "Terracotta serving bowl", unit: "piece", size: 1, base: 549, dateSensitive: false },
  { category: "Home & kitchen", name: "Cotton table runner", unit: "m", size: 2, base: 749, dateSensitive: false },
  { category: "Home & kitchen", name: "Brass diya set", unit: "piece", size: 4, base: 499, dateSensitive: false },
  { category: "Accessories", name: "Kolhapuri leather sandal", unit: "piece", size: 1, base: 1599, dateSensitive: false },
  { category: "Accessories", name: "Block print cotton scarf", unit: "piece", size: 1, base: 699, dateSensitive: false },
  { category: "Accessories", name: "Silver oxidised jhumka", unit: "piece", size: 1, base: 1199, dateSensitive: false },
  { category: "Accessories", name: "Jute tote bag", unit: "piece", size: 1, base: 549, dateSensitive: false },
  { category: "Accessories", name: "Beaded anklet", unit: "piece", size: 1, base: 399, dateSensitive: false },
  { category: "Small electronics", name: "USB-C fast charger", unit: "piece", size: 1, base: 1499, dateSensitive: false },
  { category: "Small electronics", name: "Bluetooth earbuds", unit: "piece", size: 1, base: 2499, dateSensitive: false },
  { category: "Small electronics", name: "LED desk lamp", unit: "piece", size: 1, base: 1899, dateSensitive: false },
  { category: "Small electronics", name: "Power bank 10000mAh", unit: "piece", size: 1, base: 2199, dateSensitive: false },
  { category: "Small electronics", name: "Braided charging cable", unit: "m", size: 1, base: 599, dateSensitive: false },
];

const VENDORS = [
  "Aranya Naturals",
  "Kaveri Foods",
  "Nila Home",
  "Meera Accessories",
  "Volt Studio",
  "Sattva Wellness",
  "Terra Kitchen",
  "Ira Beauty",
];

const IMPORT_ORIGINS = ["China", "United States", "United Arab Emirates", "Vietnam", "Germany"];

const round2 = (value: number) => Math.round(value * 100) / 100;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface DemoProductOptions {
  count?: number;
  now?: Date;
}

export function generateDemoCatalog(options: DemoProductOptions = {}): CatalogProduct[] {
  const count = options.count ?? 248;
  const products: CatalogProduct[] = [];

  for (let i = 0; i < count; i += 1) {
    const item = ITEMS[i % ITEMS.length]!;
    const vendor = VENDORS[i % VENDORS.length]!;
    const variantCount = i % 11 === 0 ? 2 : 1;
    const price = round2(item.base * (1 + (i % 5) * 0.04));
    const discounted = i % 3 === 0;
    const compareAt = discounted ? round2(price * (1.18 + (i % 4) * 0.04)) : null;
    const mrp = round2(Math.max(price, compareAt ?? price) * 1.12);

    const isImported = i % 9 === 4;
    const country = isImported ? IMPORT_ORIGINS[i % IMPORT_ORIGINS.length]! : "India";

    // --- declared package values -----------------------------------------
    // The audit's separation is mirrored here: manufacturer/packer/importer
    // apart, an explicit imported-package flag, canonical country plus label
    // wording, manufacture and best-before dates apart, label evidence for the
    // common name, and a unit sale price computed from MRP and net quantity.
    const netQuantityValue = i % 19 === 7 ? null : item.size;
    const netQuantityUnit = i % 19 === 7 ? null : item.unit;
    const mrpValue = i % 13 === 3 ? null : mrp;
    const computedUnitPrice = computeUnitSalePrice({
      mrp: mrpValue,
      netQuantityValue,
      netQuantityUnit,
    });
    // A fifth of the catalogue declares the unit price wrongly (or not at all),
    // which is the realistic starting point for R13.
    const unitSalePrice =
      computedUnitPrice === null
        ? null
        : i % 5 === 1
          ? null
          : i % 5 === 3
            ? round2(computedUnitPrice * 1.06)
            : computedUnitPrice;

    const manufacturerName = i % 8 === 6 ? null : `${vendor} Manufacturing`;
    const manufacturerAddress =
      i % 7 === 2
        ? null
        : `${100 + (i % 90)}, Industrial Estate, Phase ${1 + (i % 4)}, Bengaluru 560${String(
            10 + (i % 80),
          ).padStart(3, "0")}, Karnataka`;
    const packerDiffers = i % 23 === 7;
    const countryName: string | null = i % 17 === 5 ? null : country;
    const expiryType: ExpiryType =
      item.dateSensitive ? (i % 2 === 0 ? "best_before" : "use_by") : "none";

    const legal: LegalFields = {
      ...EMPTY_LEGAL_FIELDS,
      mrp: mrpValue,
      variantMrp: null,
      manufacturerName,
      manufacturerAddress,
      packerDiffersFromManufacturer: packerDiffers,
      packerName: packerDiffers ? `${vendor} Packing Unit` : null,
      packerAddress: packerDiffers
        ? `${20 + (i % 40)}, Packing Estate, Hyderabad 500${String(1 + (i % 90)).padStart(3, "0")}, Telangana`
        : null,
      sellerName: null,
      sellerAddress: null,
      countryOfOrigin: countryName,
      countryOfOriginLabel: countryName === null ? null : i % 11 === 4 ? null : `Made in ${countryName}`,
      isImportedPackage: isImported,
      importerName: !isImported
        ? null
        : i % 3 === 1
          ? null
          : "Aranya Imports Pvt Ltd",
      importerAddress: !isImported
        ? null
        : i % 3 === 1
          ? null
          : `${20 + (i % 40)} MG Road, Mumbai 400${String(1 + (i % 90)).padStart(3, "0")}, Maharashtra`,
      packageType: "packaged",
      netQuantityValue,
      netQuantityUnit,
      genericName: i % 6 === 5 ? null : item.name.replace(/^[A-Z]/, (c) => c.toLowerCase()),
      // The common name is confirmed on the pack for most products; a few carry
      // only an online title, which R6 now rejects as evidence.
      genericNameOnLabel: i % 6 !== 5 && i % 17 !== 9,
      manufacturedDate: i % 9 === 3 ? null : `${String(((i + 3) % 12) + 1).padStart(2, "0")}/2026`,
      expiryType,
      expiryDate:
        expiryType === "none"
          ? null
          : i % 12 === 5
            ? null
            : `${String(((i + 6) % 12) + 1).padStart(2, "0")}/2027`,
      unitSalePrice,
    };

    const variants = Array.from({ length: variantCount }, (_, index) => ({
      variantId: `gid://shopify/ProductVariant/${900000 + i * 10 + index}`,
      title: variantCount === 1 ? "Default" : index === 0 ? "Small" : "Large",
      price: index === 0 ? price : round2(price * 1.35),
      compareAtPrice: index === 0 ? compareAt : compareAt === null ? null : round2(compareAt * 1.35),
    }));

    products.push({
      productId: `gid://shopify/Product/${500000 + i}`,
      handle: `${slugify(`${vendor}-${item.name}-${item.size}${item.unit}`)}${i >= ITEMS.length ? `-${i}` : ""}`,
      title: `${item.name.replace(/^[A-Z]/, (c) => c.toUpperCase())} ${item.size} ${item.unit}`,
      vendor,
      productType: item.category,
      status: "ACTIVE",
      variants,
      legal,
      priorPricePublished: discounted,
    });
  }

  return products;
}

/** Vendors and product types used by the "apply default by vendor or type" control. */
export function demoGroups(products: CatalogProduct[]): { vendors: string[]; productTypes: string[] } {
  return {
    vendors: [...new Set(products.map((p) => p.vendor ?? "").filter(Boolean))].sort(),
    productTypes: [...new Set(products.map((p) => p.productType ?? "").filter(Boolean))].sort(),
  };
}
