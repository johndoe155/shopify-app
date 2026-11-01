/**
 * Captures the five App Store screenshots from the running app in preview mode.
 *
 *   npm run demo                       # in one terminal (port 3000)
 *   npm run screenshots                # in another
 *   DEMO_URL=http://localhost:4000 npm run screenshots
 *
 * Screenshots 1, 2 and 5 come from the real admin UI. Screenshots 3 and 4 render
 * the storefront block templates through /preview/storefront, which uses the same
 * markup and CSS classes as the Liquid blocks in extensions/legal-in-storefront.
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const OUT = new URL("../listing/screenshots/", import.meta.url).pathname;

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // 1. Dashboard
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Catalogue score");
  await page.screenshot({ path: `${OUT}01-dashboard.png`, fullPage: false });

  // 2. Bulk editor, with rows selected and a value chosen
  await page.goto(`${BASE}/app/bulk-editor`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Apply a value to selected rows");
  const checkboxes = page.locator("input[type=checkbox]");
  const count = Math.min(await checkboxes.count(), 4);
  for (let i = 0; i < count; i += 1) {
    await checkboxes.nth(i).check({ force: true }).catch(() => undefined);
  }
  const selects = page.locator("select");
  if ((await selects.count()) > 1) {
    await selects.nth(1).selectOption({ label: "India" }).catch(() => undefined);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}02-bulk-editor.png`, fullPage: false });

  // 3. Product page: legal declarations block
  await page.goto(`${BASE}/preview/storefront`, { waitUntil: "networkidle" });
  const declarations = page.locator('[data-legal-in-block="declarations"]');
  await declarations.waitFor();
  await declarations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}03-product-page-declarations.png`, fullPage: false });

  // 4. Footer: grievance officer block
  const grievance = page.locator('[data-legal-in-block="grievance"]');
  await grievance.waitFor();
  await grievance.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}04-grievance-block.png`, fullPage: false });

  // 5. Self-audit checklist
  await page.goto(`${BASE}/app/audit`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Dark-pattern self-audit");
  await page.screenshot({ path: `${OUT}05-self-audit.png`, fullPage: false });

  await browser.close();
  console.log(`Screenshots written to ${OUT}`);
  console.log("Base URL:", BASE);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
