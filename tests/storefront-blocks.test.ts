import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";

const root = "extensions/legal-in-storefront/";
const liquid = new Liquid();
liquid.registerFilter("asset_url", (s: string) => s);
liquid.registerFilter("stylesheet_tag", (s: string) => `<link href="${s}">`);
liquid.registerFilter("money", (cents: number) => `₹${(cents / 100).toFixed(2)}`);
liquid.registerFilter("json", (value: unknown) => JSON.stringify(value));
const templates = Object.fromEntries(["prior-price", "legal-declarations", "grievance-officer"].map((name) => [
  name, readFileSync(`${root}blocks/${name}.liquid`, "utf8").replace(/{% schema %}[\s\S]*?{% endschema %}/, ""),
]));
const script = readFileSync(`${root}assets/prior-price.js`, "utf8");
const gid = (id: string) => `gid://shopify/ProductVariant/${id}`;
const variants = [
  { variant_id: gid("9007199254740993"), prior_price: 399, show: true, label: "complete" },
  { variant_id: gid("9007199254740994"), prior_price: 0, show: true, label: "tracked_since_install" },
  { variant_id: gid("9007199254740995"), prior_price: null, show: false },
];
async function renderPrior(id: string, entries = variants) {
  return liquid.parseAndRender(templates["prior-price"]!, {
    product: { selected_or_first_available_variant: { id }, metafields: { legal_in: { prior_price: { value: {
      variants: entries, tracked_since: "2026-01-01", complete_by: "2026-01-31",
    } } } } },
    shop: { money_format: "₹{{amount}}" },
    block: { settings: {}, shopify_attributes: "" },
  });
}
function doc(html: string, id: string) {
  return new JSDOM(`<div class="shopify-section"><form action="/cart/add"><input name="id" value="${id}"></form>${html}</div>`, { runScripts: "outside-only" });
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("actual storefront Liquid and variant script", () => {
  it("renders a real GID for a numeric Liquid ID including a zero price", async () => {
    for (const [id, expected] of [["9007199254740993", "₹399.00"], ["9007199254740994", "₹0.00"]]) {
      const dom = doc(await renderPrior(id!), id!);
      const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
      expect(block.hidden).toBe(false);
      expect(block.querySelector('[data-prior-value]')?.textContent).toContain(expected);
      dom.window.close();
    }
  });
  it("finds an entry beyond the first 50 variants", async () => {
    const entries = Array.from({ length: 80 }, (_, index) => ({ variant_id: gid(String(index + 100)), prior_price: index, show: true, label: "complete" }));
    const dom = doc(await renderPrior("179", entries), "179");
    const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.hidden).toBe(false);
    expect(block.querySelector('[data-prior-value]')!.textContent).toContain("₹79.00");
    dom.window.close();
  });
  it("renders a hidden marker when the product has no prior-price data, and supports legacy numeric strings", async () => {
    // No entries at all: the block is not in the flow, and it never will be for
    // this product, so removing the box cannot cause a shift mid-session.
    const empty = doc(await renderPrior("42", []), "42");
    expect(empty.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!.hidden).toBe(true);
    empty.window.close();
    // Data exists for other variants: the block keeps its box and is idle.
    const idle = doc(await renderPrior("42"), "42");
    const idleBlock = idle.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(idleBlock.hidden).toBe(false);
    expect(idleBlock.classList.contains("legal-in--idle")).toBe(true);
    idle.window.close();
    const old = doc(await renderPrior("42", [{ variant_id: "42", prior_price: 15, show: true, label: "complete" }]), "42");
    expect(old.window.document.querySelector('[data-prior-value]')!.textContent).toContain("₹15.00");
    old.window.close();
  });
  it("updates on async changes, hides unavailable variants, restores and keeps other product blocks isolated", async () => {
    const html = await renderPrior("9007199254740993");
    const dom = new JSDOM(`<div class="shopify-section"><form action="/cart/add"><input name="id" value="9007199254740993"></form>${html}</div><div class="shopify-section"><form action="/cart/add"><input name="id" value="9007199254740993"></form>${html}</div>`, { runScripts: "outside-only" });
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    const inputs = dom.window.document.querySelectorAll<HTMLInputElement>('input[name="id"]');
    const blocks = dom.window.document.querySelectorAll<HTMLElement>('[data-legal-in-block="prior-price"]');
    inputs[0]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    inputs[0]!.value = "9007199254740994";
    await delay(150);
    expect(blocks[0]!.querySelector('[data-prior-value]')!.textContent).toBe("₹0.00");
    // One wording only: a prior price comes from a complete 30-day lookback, so
    // there is no shorter-history label to switch into (audit item L16).
    expect(blocks[0]!.textContent).toContain("Lowest price in the 30 days before the reduction was announced");
    expect(blocks[0]!.textContent).not.toContain("tracked since");
    expect(blocks[1]!.querySelector('[data-prior-value]')!.textContent).toBe("₹399.00");
    // The variant has no prior price but the product has: the block keeps its
    // box (idle) so the rest of the page does not jump.
    inputs[0]!.value = "9007199254740995";
    await delay(150);
    expect(blocks[0]!.hidden).toBe(false);
    expect(blocks[0]!.classList.contains("legal-in--idle")).toBe(true);
    inputs[0]!.value = "9007199254740993";
    await delay(150);
    expect(blocks[0]!.hidden).toBe(false);
    expect(blocks[0]!.classList.contains("legal-in--ready")).toBe(true);
    expect(blocks[0]!.querySelector('[data-prior-value]')!.textContent).toBe("₹399.00");
    // An unavailable combination is also an idle state, not a removed box.
    inputs[0]!.disabled = true;
    await delay(150);
    expect(blocks[0]!.hidden).toBe(false);
    expect(blocks[0]!.classList.contains("legal-in--idle")).toBe(true);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  });
  it("reserves the block's height so a variant switch cannot move the page", () => {
    const css = readFileSync(`${root}assets/legal-in.css`, "utf8");
    // Every row of the prior-price block has a fixed minimum height.
    expect(css).toMatch(/\.legal-in--prior-price\s*\{[^}]*min-height/s);
    expect(css).toMatch(/\.legal-in--prior-price \.legal-in__label\s*\{[^}]*min-height/s);
    expect(css).toMatch(/\.legal-in--prior-price \.legal-in__value\s*\{[^}]*min-height/s);
    expect(css).toMatch(/\.legal-in--prior-price \.legal-in__note\s*\{[^}]*min-height/s);
    // The note is clamped, so the one-line and two-line notes occupy one height.
    expect(css).toMatch(/-webkit-line-clamp:\s*var\(--legal-in-note-lines\)/);
    // The idle state hides with visibility, which keeps the box in the flow.
    expect(css).toMatch(/\.legal-in--prior-price\.legal-in--idle \.legal-in__stack\s*\{[^}]*visibility:\s*hidden/s);
    // And the state is never applied with display:none.
    expect(css).not.toMatch(/\.legal-in--idle\s*\{[^}]*display:\s*none/s);
  });

  it("marks the data id used to decide hidden versus idle in the markup", async () => {
    const html = await renderPrior("9007199254740993");
    const dom = new JSDOM(html);
    const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.dataset.hasPrior).toBe("true");
    expect(block.classList.contains("legal-in--ready")).toBe(true);
    dom.window.close();
  });

  it("keeps a marker when declarations or grievance details are empty", async () => {
    for (const name of ["legal-declarations", "grievance-officer"]) {
      const html = await liquid.parseAndRender(templates[name]!, { product: { metafields: { legal_in: {} } }, shop: { metafields: { legal_in: {} } }, block: { settings: {}, shopify_attributes: "" } });
      const dom = new JSDOM(html);
      expect(dom.window.document.querySelector<HTMLElement>('[data-legal-in-block]')?.hidden).toBe(true);
      dom.window.close();
    }
  });
  it("renders importer details for a package marked as imported", async () => {
    const html = await liquid.parseAndRender(templates["legal-declarations"]!, {
      product: {
        metafields: {
          legal_in: {
            is_imported_package: { value: true },
            importer_name: { value: "Aranya Imports Pvt Ltd" },
            importer_address: { value: "MG Road, Mumbai 400001" },
          },
        },
      },
      block: { settings: {} },
    });
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelector<HTMLElement>('[data-legal-in-block]')?.hidden).toBe(false);
    expect(dom.window.document.body.textContent).toContain("Aranya Imports Pvt Ltd");
    // The canonical country and the pack wording are separate facts (audit L5).
    expect(dom.window.document.body.textContent).toContain("Importer");
    dom.window.close();
  });

  it("does not show an importer row when the package is not marked as imported", async () => {
    // Audit item L6: the importer duty follows the declaration, not a country name.
    const html = await liquid.parseAndRender(templates["legal-declarations"]!, {
      product: {
        metafields: {
          legal_in: {
            importer_name: { value: "Aranya Imports Pvt Ltd" },
            country_of_origin: { value: "India" },
          },
        },
      },
      block: { settings: {} },
    });
    const dom = new JSDOM(html);
    expect(dom.window.document.body.textContent).not.toContain("Importer");
    dom.window.close();
  });

  it("separates the persons and the dates in the rendered markup", async () => {
    const html = await liquid.parseAndRender(templates["legal-declarations"]!, {
      product: {
        metafields: {
          legal_in: {
            mrp: { value: 300 },
            manufacturer_name: { value: "Aranya Naturals" },
            manufacturer_address: { value: "12 Industrial Estate, Bengaluru" },
            packer_differs_from_manufacturer: { value: true },
            packer_name: { value: "Aranya Packing Unit" },
            seller_name: { value: "Aranya Retail" },
            country_of_origin: { value: "India" },
            country_of_origin_label: { value: "Made in India" },
            net_quantity_value: { value: 100 },
            net_quantity_unit: { value: "ml" },
            unit_sale_price: { value: 3 },
            generic_name: { value: "face wash" },
            manufactured_date: { value: "03/2026" },
            expiry_type: { value: "best_before" },
            expiry_date: { value: "03/2027" },
          },
        },
      },
      block: { settings: {} },
    });
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent ?? "";
    expect(dom.window.document.querySelector<HTMLElement>('[data-legal-in-block]')?.hidden).toBe(false);
    expect(text).toContain("Manufacturer");
    expect(text).toContain("Packer");
    expect(text).toContain("Sold by");
    expect(text).toContain("Made in India");
    expect(text).toContain("Unit sale price");
    expect(text).toContain("per ml");
    expect(text).toContain("Month and year of manufacture");
    expect(text).toContain("Best before");
    expect(text).toContain("03/2027");
    dom.window.close();
  });
});

/**
 * Block C must never render a stale prior price (reported failure).
 *
 * The stored metafield is written by the app, but between a sale ending and the
 * next publish — or if a publish failed — the payload can say `show: true` while
 * the product's live compare-at price is gone. The block used to trust the stored
 * flag, so the storefront kept advertising "Prior price ₹282" after the sale.
 */
describe("prior-price block re-checks the live compare-at price", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    variant_id: gid("9007199254740993"),
    price: 249,
    compare_at: 399,
    prior_price: 282,
    show: true,
    label: "complete",
    ...overrides,
  });

  async function renderWithProduct(
    product: Record<string, unknown>,
    entries = [entry()],
  ) {
    return liquid.parseAndRender(templates["prior-price"]!, {
      product: {
        selected_or_first_available_variant: { id: "9007199254740993" },
        metafields: {
          legal_in: {
            prior_price: {
              value: { variants: entries, tracked_since: "2026-01-01", complete_by: "2026-01-31" },
            },
          },
        },
        ...product,
      },
      shop: { money_format: "₹{{amount}}" },
      block: { settings: {}, shopify_attributes: "" },
    });
  }

  it("renders while the variant is on sale", async () => {
    // Liquid prices are in paise and the payload is in rupees: 24900 against a
    // stored 249. Comparing them without converting meant the block never
    // rendered on a real store at all.
    const html = await renderWithProduct({
      selected_or_first_available_variant: {
        id: "9007199254740993",
        price: 24900,
        compare_at_price: 39900,
      },
    });
    const block = new JSDOM(html).window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(true);
  });

  it("stops rendering when the sale has ended, even though the stored flag says show", async () => {
    // This is the exact reported case: the metafield still carries show:true and
    // prior price 282, but the product no longer has a compare-at price.
    const html = await renderWithProduct({
      selected_or_first_available_variant: {
        id: "9007199254740993",
        price: 24900,
        compare_at_price: null,
      },
    });
    const dom = new JSDOM(html);
    const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(false);
    expect(block.classList.contains("legal-in--idle")).toBe(true);
    expect(dom.window.document.querySelector('[data-prior-value]')!.textContent).toBe("");
  });

  it("stops rendering when the stored payload predates the current price", async () => {
    // A price edit that has not been published yet: the stored entry was measured
    // against ₹249 but the variant now sells at ₹229.
    const html = await renderWithProduct({
      selected_or_first_available_variant: {
        id: "9007199254740993",
        price: 22900,
        compare_at_price: 39900,
      },
    });
    const block = new JSDOM(html).window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(false);
  });

  it("hides a payload whose compare-at is no longer above the selling price", async () => {
    const html = await renderWithProduct(
      {
        selected_or_first_available_variant: {
          id: "9007199254740993",
          price: 24900,
          compare_at_price: 24900,
        },
      },
      [entry({ compare_at: 249 })],
    );
    const block = new JSDOM(html).window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(false);
  });

  it("uses the stored pair when the theme hands over a product without prices", async () => {
    // A thin product object (no price at all) is the only case where the stored
    // payload decides on its own; a *blank compare-at price with a price present*
    // is an ended sale and must hide (the test above).
    const html = await renderWithProduct({
      selected_or_first_available_variant: { id: "9007199254740993" },
    });
    const block = new JSDOM(html).window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(true);
    expect(block.querySelector('[data-prior-value]')!.textContent).toContain("₹282.00");
  });
});

/**
 * The product JSON every theme ships exposes prices in paise, while the payload
 * the app publishes is written in rupees. The client-side re-check has to
 * convert before comparing them, or a variant switch hides a prior price the
 * server had just rendered.
 */
describe("prior-price script compares paise with rupees", () => {
  const payload = {
    variants: [
      {
        variant_id: gid("9007199254740993"),
        price: 249,
        compare_at: 399,
        prior_price: 282,
        show: true,
        label: "complete",
      },
    ],
    tracked_since: "2026-01-01",
    complete_by: "2026-01-31",
  };

  async function domWith(productJson: unknown, variantId = "9007199254740993") {
    const html = await liquid.parseAndRender(templates["prior-price"]!, {
      product: {
        selected_or_first_available_variant: { id: variantId, price: 24900, compare_at_price: 39900 },
        metafields: { legal_in: { prior_price: { value: payload } } },
      },
      shop: { money_format: "\u20b9{{amount}}" },
      block: { settings: {}, shopify_attributes: "" },
    });
    const dom = new JSDOM(
      `<div class="shopify-section"><form action="/cart/add"><input name="id" value="${variantId}"></form>` +
        `<script type="application/json" data-product-json>${JSON.stringify(productJson)}</script>${html}</div>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    const input = dom.window.document.querySelector<HTMLInputElement>('input[name="id"]')!;
    input.value = variantId;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await delay(150);
    return dom;
  }

  it("keeps the prior price when the product JSON is in paise", async () => {
    const dom = await domWith({
      variants: [{ id: "9007199254740993", price: 24900, compare_at_price: 39900 }],
    });
    const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(true);
    expect(block.querySelector('[data-prior-value]')!.textContent).toBe("\u20b9282.00");
    expect(block.textContent).toContain("Lowest price in the 30 days before the reduction was announced");
    dom.window.close();
  });

  it("hides it once the sale is gone from the product JSON", async () => {
    const dom = await domWith({
      variants: [{ id: "9007199254740993", price: 24900, compare_at_price: null }],
    });
    const block = dom.window.document.querySelector<HTMLElement>('[data-legal-in-block="prior-price"]')!;
    expect(block.classList.contains("legal-in--ready")).toBe(false);
    expect(block.querySelector('[data-prior-value]')!.textContent).toBe("");
    dom.window.close();
  });
});
