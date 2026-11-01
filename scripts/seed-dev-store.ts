#!/usr/bin/env tsx
/**
 * Seeds a development store into the local database so the dashboard has
 * something to show before a real scan has run.
 *
 *   DATABASE_URL=postgres://... npm run seed -- my-store.myshopify.com
 *
 * What it does:
 *  - creates (or updates) the Shop row with consumer care, grievance officer and
 *    policy settings, so store checks R8, R9, R10 and R12 have data
 *  - saves a self-audit record dated 11 months ago, so the reminder banner shows
 *  - writes 35 days of variant price snapshots for a price that dropped 6 days
 *    ago, so the prior-price algorithm has a complete 30-day window
 *  - writes scan results by running the real rule engine over seeded product
 *    facts, so the dashboard score is real arithmetic rather than a fixture
 *
 * What it does NOT do: call the Shopify Admin API. Metafields on the dev store
 * are filled either by the app's bulk editor or by importing the CSV exported
 * from the bulk editor. That keeps this script runnable with no tunnel.
 */
import "dotenv/config";
import { RULES_CONFIG, evaluateProduct, summariseScan } from "../app/domain/rules";
import { computePriorPrice } from "../app/domain/prior-price";
import { EMPTY_LEGAL_FIELDS, type ProductFacts } from "../app/domain/types";
import { computeUnitSalePrice } from "../app/domain/unit-price";
import { complaintEvidence } from "../app/db/types";

const DAY = 24 * 60 * 60 * 1000;

function seededProducts(now: Date): ProductFacts[] {
  const specs = [
    { title: "Neem face wash 100 ml", mrp: 299, price: 249, compareAt: 349, complete: true },
    { title: "Amla hair oil 200 ml", mrp: 399, price: 349, compareAt: null, complete: true },
    { title: "Turmeric latte mix 150 g", mrp: 429, price: 379, compareAt: null, complete: true },
    { title: "Copper water bottle", mrp: 999, price: 899, compareAt: 1099, complete: false },
    { title: "USB-C fast charger", mrp: 1699, price: 1499, compareAt: null, complete: true },
    { title: "Rose water toner 120 ml", mrp: null, price: 199, compareAt: null, complete: false },
  ];

  return specs.map((spec, index) => {
    const variantId = `gid://shopify/ProductVariant/${1000 + index}`;
    const prior = spec.compareAt
      ? computePriorPrice({
          snapshots: [
            { price: Math.round(spec.price * 1.22), observedAt: new Date(now.getTime() - 34 * DAY) },
            { price: spec.price, observedAt: new Date(now.getTime() - 6 * DAY) },
          ],
          current: {
            price: spec.price,
            compareAtPrice: spec.compareAt,
            effectiveAt: new Date(now.getTime() - 6 * DAY),
          },
          trackingStart: new Date(now.getTime() - 35 * DAY),
        })
      : null;

    return {
      productId: `gid://shopify/Product/${1000 + index}`,
      handle: spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title: spec.title,
      vendor: "Aranya Naturals",
      productType: index % 2 === 0 ? "Beauty & personal care" : "Home & kitchen",
      status: "ACTIVE",
      legal: {
        ...EMPTY_LEGAL_FIELDS,
        mrp: spec.mrp,
        manufacturerName: "Aranya Naturals Manufacturing",
        manufacturerAddress: "12 Industrial Estate, Bengaluru 560001, Karnataka",
        packerDiffersFromManufacturer: false,
        countryOfOrigin: "India",
        countryOfOriginLabel: "Made in India",
        isImportedPackage: false,
        packageType: "packaged",
        netQuantityValue: 100,
        netQuantityUnit: "ml",
        genericName: spec.title.split(" ")[0]!.toLowerCase(),
        genericNameOnLabel: true,
        manufacturedDate: index % 4 === 3 ? null : "03/2026",
        expiryType: index % 3 === 0 ? "best_before" : "none",
        expiryDate: index % 3 === 0 ? "05/2027" : null,
        unitSalePrice: computeUnitSalePrice({
          mrp: spec.mrp,
          netQuantityValue: 100,
          netQuantityUnit: "ml",
        }),
      },
      variants: [
        {
          variantId,
          title: "Default",
          price: spec.price,
          compareAtPrice: spec.compareAt,
          priorPrice: prior ? { ...prior, variantId } : null,
        },
      ],
      priorPricePublished: spec.complete,
    } satisfies ProductFacts;
  });
}

async function main() {
  const shopDomain = process.argv[2] ?? "demo-store.myshopify.com";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Point it at the app database and run again.");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const now = new Date();
  const installedAt = new Date(now.getTime() - 35 * DAY);

  try {
    const shop = await prisma.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        installedAt,
        plan: "pro",
        planStatus: "ACTIVE",
        billingInterval: "monthly",
        storeName: "Aranya Naturals",
        consumerCareAddress: "12 Industrial Estate, Bengaluru 560001, Karnataka",
        consumerCarePhone: "+91 80 4123 7788",
        consumerCareEmail: "care@aranyanaturals.example",
        platformCustomerCareUrl: "/pages/contact",
        grievanceName: "Priya Menon",
        grievanceDesignation: "Grievance Officer",
        grievanceEmail: "grievance@aranyanaturals.example",
        grievancePhone: "+91 80 4123 7799",
        returnPolicyUrl: "/pages/returns",
        refundPolicyUrl: "/pages/refunds",
        exchangePolicyUrl: "/pages/exchanges",
        warrantyPolicyUrl: "/pages/warranty",
        deliveryTermsUrl: "/pages/shipping",
        returnShippingCostText: "Free on damaged items",
        paymentModesUrl: "/pages/payment-methods",
        grievanceRedressalUrl: "/pages/grievance-redressal",
        otherInformationText: "Country of origin is printed on each pack.",
        useBeforeInfoText: "Best-before dates are printed on the pack.",
        blocksDetectedJson: { declarations: "detected", grievance: "detected", priorPrice: "detected" },
        blocksDetectedAt: now,
      },
      update: { installedAt },
    });

    await prisma.auditRecord.deleteMany({ where: { shopId: shop.id } });
    await prisma.auditRecord.create({
      data: {
        shopId: shop.id,
        completedAt: new Date(now.getTime() - 340 * DAY),
        answersJson: {
          answers: [
            { id: "false_urgency", answer: false, notes: "" },
            { id: "confirm_shaming", answer: true, notes: "Cart drawer wording to be rewritten." },
            { id: "drip_pricing", answer: true, notes: "Delivery fee appears at checkout step 2." },
          ],
        },
      },
    });

    const products = seededProducts(now);
    await prisma.priceSnapshot.deleteMany({ where: { shopId: shop.id } });
    await prisma.priceSnapshot.createMany({
      data: products.flatMap((product) =>
        product.variants
          .filter((variant) => variant.compareAtPrice !== null)
          .flatMap((variant) => [
            {
              shopId: shop.id,
              productId: product.productId,
              variantId: variant.variantId,
              price: Math.round(variant.price * 1.22),
              compareAt: variant.compareAtPrice,
              observedAt: new Date(now.getTime() - 34 * DAY),
              source: "install",
            },
            {
              shopId: shop.id,
              productId: product.productId,
              variantId: variant.variantId,
              price: variant.price,
              compareAt: variant.compareAtPrice,
              observedAt: new Date(now.getTime() - 6 * DAY),
              source: "webhook",
            },
          ]),
      ),
    });

    const storeFacts = {
      shopDomain,
      consumerCare: {
        storeName: shop.storeName,
        address: shop.consumerCareAddress,
        phone: shop.consumerCarePhone,
        email: shop.consumerCareEmail,
      },
      platformCustomerCareUrl: shop.platformCustomerCareUrl,
      grievanceOfficer: {
        name: shop.grievanceName,
        designation: shop.grievanceDesignation,
        email: shop.grievanceEmail,
        phone: shop.grievancePhone,
      },
      policyLinkChecks: {},
      policies: {
        returnPolicy: { url: shop.returnPolicyUrl, text: shop.returnPolicyText },
        refundPolicy: { url: shop.refundPolicyUrl, text: shop.refundPolicyText },
        exchangePolicy: { url: shop.exchangePolicyUrl, text: shop.exchangePolicyText },
        warrantyPolicy: { url: shop.warrantyPolicyUrl, text: shop.warrantyPolicyText },
        deliveryTerms: { url: shop.deliveryTermsUrl, text: shop.deliveryTermsText },
        returnShippingCost: { url: shop.returnShippingCostUrl, text: shop.returnShippingCostText },
        paymentModes: { url: shop.paymentModesUrl, text: shop.paymentModesText },
        grievanceRedressal: { url: shop.grievanceRedressalUrl, text: shop.grievanceRedressalText },
        otherInformation: { url: shop.otherInformationUrl, text: shop.otherInformationText },
        useBeforeInfo: { url: shop.useBeforeInfoUrl, text: shop.useBeforeInfoText },
      },
      complaints: complaintEvidence([]),
      blocks: { declarations: "detected" as const, grievance: "detected" as const, priorPrice: "detected" as const },
      lastAuditAt: new Date(now.getTime() - 340 * DAY),
      installDate: installedAt,
      priceTrackingStart: installedAt,
    };

    const outcomes = products.map((product) => evaluateProduct(product, storeFacts, RULES_CONFIG));
    await prisma.scanResult.deleteMany({ where: { shopId: shop.id } });
    await prisma.scanResult.createMany({
      data: outcomes.flatMap((outcome, index) =>
        outcome.results.map((result) => ({
          shopId: shop.id,
          productId: outcome.productId,
          productHandle: outcome.handle,
          productTitle: outcome.title,
          productVendor: products[index]!.vendor,
          productType: products[index]!.productType,
          ruleId: result.ruleId,
          status: result.status,
          message: result.message,
          scannedAt: now,
        })),
      ),
    });

    const summary = summariseScan(outcomes);
    console.log(`Seeded ${shopDomain}`);
    console.log(`  ${summary.passingProducts}/${summary.totalProducts} products pass every check (${summary.scorePercent}%)`);
    console.log(`  ${summary.byRule.filter((rule) => rule.fail > 0).length} checks have failures`);
    console.log("  Open /app to see it. Product metafields are filled from the bulk editor or a CSV import.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
