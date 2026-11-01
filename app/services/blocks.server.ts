/**
 * F4 / R10 / R11 — "is the block live?" detection.
 *
 * `read_themes` is deliberately not requested (brief section 3: least-privilege
 * scopes). Instead the app fetches the public storefront and looks for the
 * marker attribute each theme app block renders. When the storefront cannot be
 * fetched (password-protected, custom domain issues, network), the dashboard
 * falls back to a manual "I've added the block" confirmation, which is stored on
 * the shop and accepted by the rule engine as `confirmed_manual`. A missing
 * marker is inconclusive (different templates, password pages, unpublished
 * products), not proof that a block is absent. Markers prove placement on
 * the sampled page, not visibility or placement on every product template.
 */
import type { BlockStatuses } from "~/domain/types";

export const BLOCK_MARKERS = {
  declarations: 'data-legal-in-block="declarations"',
  grievance: 'data-legal-in-block="grievance"',
  priorPrice: 'data-legal-in-block="prior-price"',
} as const;

export type BlockName = keyof typeof BLOCK_MARKERS;

export interface DetectBlocksOptions {
  shopDomain: string;
  /** A product handle to check the product-page blocks against. */
  productHandle?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DetectBlocksResult {
  blocks: BlockStatuses;
  reachable: boolean;
  checkedUrls: string[];
  errors: string[];
}

async function fetchHtml(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "IndiaLegalMetrologyMRP/1.0 (block check)" },
      redirect: "follow",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectStorefrontBlocks(
  options: DetectBlocksOptions,
): Promise<DetectBlocksResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const urls = [`https://${options.shopDomain}/`];
  if (options.productHandle) {
    urls.push(`https://${options.shopDomain}/products/${encodeURIComponent(options.productHandle)}`);
  }

  const pages: string[] = [];
  const errors: string[] = [];
  for (const url of urls) {
    const html = await fetchHtml(url, fetchImpl, timeoutMs);
    if (html === null) {
      errors.push(`Could not read ${url}.`);
      continue;
    }
    pages.push(html);
  }

  const reachable = pages.length > 0;
  const detected = (name: BlockName): boolean =>
    pages.some((html) => html.includes(BLOCK_MARKERS[name]));

  const status = (name: BlockName): BlockStatuses[BlockName] =>
    detected(name) ? "detected" : "unknown";

  return {
    blocks: {
      declarations: status("declarations"),
      grievance: status("grievance"),
      priorPrice: status("priorPrice"),
    },
    reachable,
    checkedUrls: urls,
    errors,
  };
}
