import { describe, expect, it } from "vitest";
import { BLOCK_MARKERS, detectStorefrontBlocks } from "~/services/blocks.server";
import { legalFieldsFromMetafields, parseProductJsonl } from "~/services/catalog.server";
import { DEFINITION_SPECS } from "~/services/metafield-definitions.server";

function fetchReturning(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

describe("storefront block detection", () => {
  it("detects a block from its marker attribute on the product page", async () => {
    const result = await detectStorefrontBlocks({
      shopDomain: "demo.myshopify.com",
      productHandle: "amla-hair-oil",
      fetchImpl: fetchReturning({
        "https://demo.myshopify.com/": "<footer></footer>",
        "https://demo.myshopify.com/products/amla-hair-oil": `<div ${BLOCK_MARKERS.declarations}></div><div ${BLOCK_MARKERS.priorPrice}></div>`,
      }),
    });
    expect(result.reachable).toBe(true);
    expect(result.blocks.declarations).toBe("detected");
    expect(result.blocks.priorPrice).toBe("detected");
    expect(result.blocks.grievance).toBe("unknown");
  });

  it("detects the footer block from the home page", async () => {
    const result = await detectStorefrontBlocks({
      shopDomain: "demo.myshopify.com",
      fetchImpl: fetchReturning({
        "https://demo.myshopify.com/": `<section ${BLOCK_MARKERS.grievance}></section>`,
      }),
    });
    expect(result.blocks.grievance).toBe("detected");
  });

  it("reports unreachable instead of pretending the blocks are missing", async () => {
    const result = await detectStorefrontBlocks({
      shopDomain: "demo.myshopify.com",
      fetchImpl: fetchReturning({}),
    });
    expect(result.reachable).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("treats password pages and failed product fetches as unknown, not absent", async () => {
    const result = await detectStorefrontBlocks({
      shopDomain: "demo.myshopify.com", productHandle: "product",
      fetchImpl: fetchReturning({ "https://demo.myshopify.com/": "<form action='/password'></form>" }),
    });
    expect(result.reachable).toBe(true);
    expect(result.blocks).toEqual({ declarations: "unknown", grievance: "unknown", priorPrice: "unknown" });
    expect(result.errors).toHaveLength(1);
  });

  it("survives a fetch that throws", async () => {
    const result = await detectStorefrontBlocks({
      shopDomain: "demo.myshopify.com",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(result.reachable).toBe(false);
  });
});

describe("bulk operation JSONL parsing", () => {
  const lines = [
    JSON.stringify({
      id: "gid://shopify/Product/1",
      handle: "amla-hair-oil",
      title: "Amla hair oil",
      vendor: "Aranya Naturals",
      productType: "Beauty & personal care",
      status: "ACTIVE",
    }),
    JSON.stringify({
      id: "gid://shopify/ProductVariant/11",
      __parentId: "gid://shopify/Product/1",
      title: "Default",
      price: "249.00",
      compareAtPrice: "399.00",
    }),
    JSON.stringify({
      id: "gid://shopify/Metafield/101",
      __parentId: "gid://shopify/Product/1",
      key: "mrp",
      value: "300.00",
    }),
    JSON.stringify({
      id: "gid://shopify/Metafield/102",
      __parentId: "gid://shopify/Product/1",
      key: "country_of_origin",
      value: "India",
    }),
    JSON.stringify({
      id: "gid://shopify/Metafield/103",
      __parentId: "gid://shopify/Product/1",
      key: "net_quantity_unit",
      value: "ml",
    }),
    JSON.stringify({
      id: "gid://shopify/Metafield/104",
      __parentId: "gid://shopify/Product/1",
      key: "prior_price",
      value: '{"variants":[]}',
    }),
    // a truncated final line, which must not fail the scan
    '{"id":"gid://shopify/Product/2","handle":"half',
  ];

  it("reassembles products, variants and metafields", () => {
    const products = parseProductJsonl(lines);
    expect(products).toHaveLength(1);
    const product = products[0]!;
    expect(product.handle).toBe("amla-hair-oil");
    expect(product.variants).toEqual([
      { variantId: "gid://shopify/ProductVariant/11", title: "Default", price: 249, compareAtPrice: 399 },
    ]);
    expect(product.legal.mrp).toBe(300);
    expect(product.legal.countryOfOrigin).toBe("India");
    expect(product.legal.netQuantityUnit).toBe("ml");
    expect(product.priorPricePublished).toBe(true);
  });

  it("ignores metafields with unknown keys, bad numbers and bad units", () => {
    const fields = legalFieldsFromMetafields([
      { key: "mrp", value: "not-a-number" },
      { key: "net_quantity_value", value: "abc" },
      { key: "net_quantity_unit", value: "oz" },
      { key: "expiry_type", value: "whenever" },
      { key: "unknown_key", value: "x" },
    ]);
    expect(fields.mrp).toBeNull();
    expect(fields.netQuantityValue).toBeNull();
    expect(fields.netQuantityUnit).toBeNull();
    expect(fields.expiryType).toBe("none");
  });

  it("handles an empty result set", () => {
    expect(parseProductJsonl([])).toEqual([]);
  });
});

describe("metafield definitions", () => {
  it("declares the product declarations, prior price and shop settings", () => {
    const keys = DEFINITION_SPECS.map((spec) => spec.key);
    // Audit items L4-L9 and L1: the persons and dates are separate declarations,
    // the imported-package flag replaces the country-code proxy, and the unit sale
    // price is a declaration in its own right.
    expect(keys).toEqual([
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
      "prior_price",
      "settings",
    ]);
    expect(keys).toHaveLength(25);
  });

  it("uses the specified types and constrains units, package types and expiry types", () => {
    const byKey = Object.fromEntries(DEFINITION_SPECS.map((spec) => [spec.key, spec]));
    expect(byKey.mrp!.type).toBe("number_decimal");
    expect(byKey.variant_mrp!.type).toBe("json");
    expect(byKey.manufacturer_address!.type).toBe("multi_line_text_field");
    expect(byKey.net_quantity_unit!.type).toBe("single_line_text_field");
    expect(byKey.net_quantity_unit!.validations).toEqual([
      { name: "choices", value: "g,kg,ml,l,cm,m,number,unit,piece,pair,set" },
    ]);
    expect(byKey.package_type!.validations).toEqual([
      { name: "choices", value: "packaged,combination,multi_piece,wholesale,excluded" },
    ]);
    expect(byKey.expiry_type!.validations).toEqual([
      { name: "choices", value: "none,best_before,use_by" },
    ]);
    expect(byKey.settings!.ownerType).toBe("SHOP");
    expect(byKey.prior_price!.type).toBe("json");
  });
});
