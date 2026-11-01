/**
 * Preview-only route: renders the three storefront blocks the way the theme app
 * extension renders them, using the demo shop's own settings and a demo product.
 *
 * This exists so the block templates can be seen (and screenshotted) without a
 * Shopify dev store. It is only reachable when DEMO_MODE=1.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { isDemoMode } from "~/context.server";
import { getDemoState } from "~/demo/demo.server";
import { formatInr } from "~/domain/copy";
import { computePriorPrice, decideBlockC } from "~/domain/prior-price";
import { assessUnitSalePrice, standardUnitLabel } from "~/domain/unit-price";
import { resolvePriceEffectiveAt } from "~/services/price-history.server";
import { buildShopSettingsMetafield } from "~/services/shop-settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isDemoMode()) throw new Response("Not found", { status: 404 });
  const state = await getDemoState();
  const products = await state.catalog.fetchProducts();
  const product =
    products.find((candidate) =>
      candidate.variants.some((variant) => variant.compareAtPrice !== null && variant.compareAtPrice > variant.price),
    ) ?? products[0]!;
  const variant = product.variants[0]!;
  const snapshots = await state.repo.listPriceSnapshots(state.shop.id);
  const variantSnapshots = snapshots.filter((snapshot) => snapshot.variantId === variant.variantId);
  // Same two steps the app uses when it publishes the metafield: work out when the
  // current price took effect, then take the lowest price in the 30 days before it.
  const effectiveAt = resolvePriceEffectiveAt(
    variantSnapshots.map((snapshot) => ({
      price: snapshot.price,
      compareAt: snapshot.compareAt,
      observedAt: snapshot.observedAt,
    })),
    { price: variant.price, compareAtPrice: variant.compareAtPrice },
    new Date(),
  );
  const prior = computePriorPrice({
    snapshots: variantSnapshots.map((snapshot) => ({ price: snapshot.price, observedAt: snapshot.observedAt })),
    current: {
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      effectiveAt,
      // A price that fell is a variant-price announcement; a compare-at price that
      // appeared above an unchanged selling price is a compare-at announcement.
      mechanism: variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? "compare_at" : "variant_price",
      conditions: null,
    },
    trackingStart: state.shop.installedAt,
  });
  const decision = decideBlockC(
    { price: variant.price, compareAtPrice: variant.compareAtPrice, effectiveAt },
    prior,
  );
  const unitPrice = assessUnitSalePrice({
    mrp: product.legal.mrp,
    netQuantityValue: product.legal.netQuantityValue,
    netQuantityUnit: product.legal.netQuantityUnit,
    packageType: product.legal.packageType,
  });
  const url = new URL(request.url);
  return {
    product,
    variant,
    prior: {
      show: decision.show,
      priorPrice: decision.priorPrice,
      label: decision.history,
      trackedSince: prior.trackedSince.toISOString(),
      completeBy: prior.completeBy.toISOString(),
    },
    unitPrice: {
      applicable: unitPrice.applicable,
      expected: unitPrice.expected,
      declared: product.legal.unitSalePrice,
      label:
        product.legal.netQuantityUnit === null
          ? null
          : standardUnitLabel(product.legal.netQuantityUnit),
    },
    settings: buildShopSettingsMetafield(state.shop),
    path: url.pathname,
  };
}

const rupee = formatInr;

export default function StorefrontPreview() {
  const { product, variant, prior, settings, unitPrice } = useLoaderData<typeof loader>();
  const legal = product.legal;
  const officer = settings.grievance_officer;

  return (
    <div style={{ fontFamily: "Assistant, Helvetica, Arial, sans-serif", color: "#121212", background: "#fff" }}>
      <style>{`
        .pv-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
        .pv-nav { display:flex; justify-content:space-between; align-items:center; padding:20px 0; border-bottom:1px solid #e5e5e5; }
        .pv-nav a { color:#121212; text-decoration:none; font-size:14px; margin-left:20px; }
        .pv-brand { font-size:20px; letter-spacing:.12em; text-transform:uppercase; font-weight:600; }
        .pv-grid { display:grid; grid-template-columns: 1.05fr 1fr; gap:56px; padding:48px 0 64px; align-items:start; }
        .pv-image { background:#f1ece4; border-radius:8px; aspect-ratio:4/5; width:100%; align-self:start; display:flex; align-items:center; justify-content:center; color:#8a8072; font-size:14px; letter-spacing:.08em; text-transform:uppercase; }
        .pv-title { font-size:30px; margin:0 0 8px; font-weight:600; }
        .pv-price { font-size:24px; margin:16px 0 4px; }
        .pv-compare { color:#8a8a8a; text-decoration:line-through; margin-right:10px; font-size:18px; }
        .pv-save { color:#b12704; font-size:14px; }
        .pv-desc { color:#4a4a4a; font-size:15px; line-height:1.6; margin:20px 0 0; max-width:52ch; }
        .legal-in { --legal-in-border: rgba(0,0,0,.12); font-size:15px; line-height:1.5; margin:24px 0; }
        .legal-in__heading { font-size:16px; font-weight:600; margin:0 0 8px; }
        .legal-in__list { border-collapse:collapse; margin:0; padding:0; width:100%; }
        .legal-in__row { display:flex; gap:16px; border-top:1px solid var(--legal-in-border); padding:7px 0; align-items:start; }
        .legal-in__row:last-child { border-bottom:1px solid var(--legal-in-border); }
        .legal-in__term { flex:0 0 46%; font-weight:500; margin:0; }
        .legal-in__value { flex:1 1 auto; margin:0; white-space:pre-line; }
        .legal-in__note { font-size:13px; margin:6px 0 0; opacity:.8; }
        .legal-in__label { font-weight:600; margin:0; }
        .legal-in__stack > * + * { margin-top:5px; }
        .legal-in__statement { margin:8px 0 0; max-width:60ch; }
        .legal-in--bordered { border:1px solid var(--legal-in-border); border-radius:6px; padding:16px; }
        footer.pv-footer { background:#f7f5f1; border-top:1px solid #e5e5e5; padding:48px 0 64px; }
        .pv-cols { display:grid; grid-template-columns: repeat(3, 1fr); gap:40px; }
        .pv-footer h4 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; margin:0 0 12px; }
        .pv-footer p, .pv-footer a { font-size:14px; color:#4a4a4a; line-height:1.7; }
      `}</style>

      <div className="pv-wrap">
        <nav className="pv-nav">
          <span className="pv-brand">Aranya Naturals</span>
          <span>
            <a href="#shop">Shop</a>
            <a href="#about">Our story</a>
            <a href="#contact">Contact</a>
          </span>
        </nav>

        <div className="pv-grid">
          <div className="pv-image">Product image</div>
          <div>
            <p style={{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: "#8a8072", margin: 0 }}>
              {product.productType}
            </p>
            <h1 className="pv-title">{product.title}</h1>
            <p style={{ fontSize: 14, color: "#6a6a6a", margin: 0 }}>{product.vendor}</p>

            <p className="pv-price">
              {variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? (
                <span className="pv-compare">{rupee(variant.compareAtPrice)}</span>
              ) : null}
              {rupee(variant.price)}
              {variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? (
                <span className="pv-save" style={{ marginLeft: 10 }}>
                  Save {Math.round((1 - variant.price / variant.compareAtPrice) * 100)}%
                </span>
              ) : null}
            </p>
            <p style={{ fontSize: 13, color: "#6a6a6a", margin: 0 }}>Taxes included. Shipping calculated at checkout.</p>

            <p className="pv-desc">
              Small-batch, made in Bengaluru. Cold-pressed and packed in recyclable glass. Suitable for daily use.
            </p>

            {prior.show ? (
              <section className="legal-in legal-in--prior-price legal-in--bordered" data-legal-in-block="prior-price">
                <div className="legal-in__stack">
                  <p className="legal-in__label">Prior price</p>
                  <p className="legal-in__value">{rupee(prior.priorPrice ?? 0)}</p>
                  <p className="legal-in__note">
                    Lowest price in the 30 days before the current price took effect, inclusive of taxes.
                  </p>
                </div>
              </section>
            ) : null}

            <section className="legal-in legal-in--declarations legal-in--bordered" data-legal-in-block="declarations">
              <h2 className="legal-in__heading">Product declarations</h2>
              <dl className="legal-in__list">
                {legal.mrp !== null ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">MRP, inclusive of all taxes</dt>
                    <dd className="legal-in__value">{rupee(legal.mrp)}</dd>
                  </div>
                ) : null}
                {legal.manufacturerName || legal.manufacturerAddress ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Manufacturer</dt>
                    <dd className="legal-in__value">
                      {[legal.manufacturerName, legal.manufacturerAddress].filter(Boolean).join(", ")}
                    </dd>
                  </div>
                ) : null}
                {legal.packerDiffersFromManufacturer && legal.packerName ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Packer</dt>
                    <dd className="legal-in__value">
                      {[legal.packerName, legal.packerAddress].filter(Boolean).join(", ")}
                    </dd>
                  </div>
                ) : null}
                {legal.sellerName || legal.sellerAddress ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Sold by</dt>
                    <dd className="legal-in__value">
                      {[legal.sellerName, legal.sellerAddress].filter(Boolean).join(", ")}
                    </dd>
                  </div>
                ) : null}
                {legal.countryOfOrigin ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Country of origin</dt>
                    <dd className="legal-in__value">
                      {legal.countryOfOriginLabel
                        ? `${legal.countryOfOrigin} (pack states: ${legal.countryOfOriginLabel})`
                        : legal.countryOfOrigin}
                    </dd>
                  </div>
                ) : null}
                {legal.isImportedPackage && (legal.importerName || legal.importerAddress) ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Importer</dt>
                    <dd className="legal-in__value">
                      {[legal.importerName, legal.importerAddress].filter(Boolean).join(", ")}
                    </dd>
                  </div>
                ) : null}
                {legal.netQuantityValue !== null ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Net quantity</dt>
                    <dd className="legal-in__value">
                      {legal.netQuantityValue} {legal.netQuantityUnit}
                    </dd>
                  </div>
                ) : null}
                {unitPrice.applicable && unitPrice.label ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Unit sale price</dt>
                    <dd className="legal-in__value">
                      {unitPrice.declared !== null
                        ? `${rupee(unitPrice.declared)} ${unitPrice.label}`
                        : `not declared (should be ${rupee(unitPrice.expected ?? 0)} ${unitPrice.label})`}
                    </dd>
                  </div>
                ) : null}
                {legal.genericName ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Common name</dt>
                    <dd className="legal-in__value">{legal.genericName}</dd>
                  </div>
                ) : null}
                {legal.manufacturedDate ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">Month and year of manufacture</dt>
                    <dd className="legal-in__value">{legal.manufacturedDate}</dd>
                  </div>
                ) : null}
                {legal.expiryType !== "none" && legal.expiryDate ? (
                  <div className="legal-in__row">
                    <dt className="legal-in__term">
                      {legal.expiryType === "best_before" ? "Best before" : "Use by"}
                    </dt>
                    <dd className="legal-in__value">{legal.expiryDate}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
          </div>
        </div>
      </div>

      <footer className="pv-footer">
        <div className="pv-wrap pv-cols">
          <div>
            <h4>Customer care</h4>
            <p>{settings.store_name}</p>
            <p>
              {settings.consumer_care.phone}
              <br />
              <a href={`mailto:${settings.consumer_care.email}`}>{settings.consumer_care.email}</a>
            </p>
            <p>Returns 7 days · Exchange 7 days · Free return shipping on damaged items</p>
          </div>
          <div>
            <h4>About</h4>
            <p>Our story</p>
            <p>Ingredients</p>
            <p>Shipping and delivery</p>
          </div>
          <div>
            <section className="legal-in legal-in--grievance" data-legal-in-block="grievance">
              <h2 className="legal-in__heading">Grievance officer</h2>
              <dl className="legal-in__list">
                <div className="legal-in__row">
                  <dt className="legal-in__term">Name</dt>
                  <dd className="legal-in__value">{officer.name}</dd>
                </div>
                <div className="legal-in__row">
                  <dt className="legal-in__term">Designation</dt>
                  <dd className="legal-in__value">{officer.designation}</dd>
                </div>
                <div className="legal-in__row">
                  <dt className="legal-in__term">Email</dt>
                  <dd className="legal-in__value">
                    <a href={`mailto:${officer.email}`}>{officer.email}</a>
                  </dd>
                </div>
                <div className="legal-in__row">
                  <dt className="legal-in__term">Phone</dt>
                  <dd className="legal-in__value">{officer.phone}</dd>
                </div>
                <div className="legal-in__row">
                  <dt className="legal-in__term">Address</dt>
                  <dd className="legal-in__value">{settings.consumer_care.address}</dd>
                </div>
              </dl>
              <p className="legal-in__statement">
                Complaints are acknowledged within 48 hours and resolved within one month of being received.
              </p>
            </section>
          </div>
        </div>
      </footer>
    </div>
  );
}
