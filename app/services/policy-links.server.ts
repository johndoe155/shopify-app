/**
 * R9 — policy-link accessibility.
 *
 * Audit item L11: "A link or text field is not automatically enough. The content
 * must be accurate, live, accessible, prominent and available at the
 * pre-purchase stage. A hidden, broken or incomplete policy link should fail."
 *
 * This service performs the only part the app can actually observe: whether the
 * URL answers, and whether what it answers with looks like a real page rather
 * than an empty template, a password page or a redirect loop. The results are
 * stored per policy key and R9 reads them; a link that was never checked — or
 * was last checked long enough ago that the answer no longer means anything — is
 * reported as unverified rather than assumed good.
 *
 * **The URLs are typed by the merchant, so this file treats them as hostile.**
 *
 *  - only `https:` is fetched;
 *  - the host must be a public one: loopback, link-local (including the cloud
 *    metadata address), private RFC 1918 space, carrier-grade NAT and the
 *    reserved and multicast blocks are all refused;
 *  - the host is resolved first and every address it resolves to is checked, so
 *    a hostname pointed at 127.0.0.1 is refused too, not just the literal;
 *  - redirects are followed by hand, at most `MAX_REDIRECTS` of them, and each
 *    hop is re-validated, so an allowed host cannot redirect into the network;
 *  - the body is read through the stream and capped, so a "policy page" that is
 *    really a 4 GB file cannot exhaust the process.
 */
import type { PolicyLinkCheck } from "~/domain/types";
import type { ShopRecord } from "~/db/types";
import { POLICY_FIELDS } from "~/domain/policies";

export interface CheckPolicyLinksOptions {
  shop: ShopRecord;
  shopDomain: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
  /** Injectable for tests: resolves a hostname to its addresses. */
  lookup?: LookupFn;
}

/** Absolute URL for a stored policy link (relative storefront paths are resolved). */
export function resolvePolicyUrl(rawUrl: string, shopDomain: string): string {
  const value = rawUrl.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${shopDomain}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** Body cap for one fetched page. Enough for any real policy page. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Redirect hops the checker will follow before it gives up. */
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 8000;

const SUSPICIOUS_MARKERS = [
  "enter store password",
  "this store is unavailable",
  "page not found",
  "404 not found",
];

/** Hostnames that are never a public policy page, whatever they resolve to. */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  "metadata.google.internal",
  "metadata",
];

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

// ---------------------------------------------------------------------------
// Address safety
// ---------------------------------------------------------------------------

function ipv4ToBytes(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

/** Expands an IPv6 literal (with `::` and an optional trailing IPv4 part). */
function ipv6ToBytes(input: string): Uint8Array | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);

  const parseGroups = (value: string): number[] | null => {
    if (value === "") return [];
    const out: number[] = [];
    for (const chunk of value.split(":")) {
      if (chunk === "") return null;
      if (chunk.includes(".")) {
        // A trailing IPv4 literal occupies the last two 16-bit groups.
        const octets = chunk.split(".");
        if (octets.length !== 4) return null;
        const nums = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
        if (nums.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        out.push((nums[0]! << 8) | nums[1]!, (nums[2]! << 8) | nums[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      out.push(parseInt(chunk, 16));
    }
    return out;
  };

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups =
    halves.length === 2 ? [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...tail] : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = (groups[index]! >> 8) & 0xff;
    bytes[index * 2 + 1] = groups[index]! & 0xff;
  }
  return bytes;
}

/** IPv4 blocks that are never a public web server. */
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including 169.254.169.254 (cloud metadata)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

function blockedIpv4(bytes: Uint8Array): boolean {
  const value =
    ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  for (const [base, bits] of BLOCKED_V4) {
    const baseBytes = ipv4ToBytes(base)!;
    const baseValue =
      ((baseBytes[0]! << 24) >>> 0) + (baseBytes[1]! << 16) + (baseBytes[2]! << 8) + baseBytes[3]!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

function blockedIpv6(bytes: Uint8Array): boolean {
  const zeros = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (bytes[index] !== 0) return false;
    return true;
  };
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (zeros(0, 15) && bytes[15] === 1) return true; // ::1
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return blockedIpv4(bytes.slice(12)); // ::ffff:0:0/96
  if (zeros(0, 12) && !zeros(12, 16)) return blockedIpv4(bytes.slice(12)); // ::a.b.c.d (deprecated)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedIpv4(bytes.slice(2, 6)); // 2002::/16 6to4
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return blockedIpv4(bytes.slice(12)); // 64:ff9b::/96 NAT64
  }
  return false;
}

/** True when this address must not be fetched. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, "");
  if (!value) return true;
  const v4 = ipv4ToBytes(value);
  if (v4) return blockedIpv4(v4);
  const v6 = ipv6ToBytes(value);
  if (v6) return blockedIpv6(v6);
  // Not an IP literal at all: it is a name, which the caller resolves first.
  return false;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(suffix)) return true;
  }
  return false;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  const dns = await import("node:dns/promises");
  const results = await dns.lookup(hostname, { all: true });
  return results.map((result) => ({ address: result.address }));
}

export interface UrlSafety {
  ok: boolean;
  /** Why the URL was refused, for the stored check record. */
  reason: string | null;
}

/**
 * Everything about a URL that can be decided without touching the network:
 * the scheme, the host's shape, and an IP literal's range.
 */
export function checkUrlShape(rawUrl: string): UrlSafety {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `only https links are fetched (got ${url.protocol})` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in the URL are not allowed" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (blockedHostname(host)) return { ok: false, reason: `"${host}" is not a public host` };
  if (host.startsWith("[") || /^[0-9a-fA-F:]+$/.test(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: `"${host}" is not a public address` };
  }
  return { ok: true, reason: null };
}

/**
 * The full check: shape first, then resolution.
 *
 * A hostname is resolved before it is fetched so that a name pointing at
 * 127.0.0.1, 169.254.169.254 or any private range is refused as well — checking
 * the literal alone is the hole every SSRF filter gets caught on. Every address
 * the name resolves to must be public, not just the first.
 */
export async function checkUrlSafety(rawUrl: string, lookup: LookupFn = defaultLookup): Promise<UrlSafety> {
  const shape = checkUrlShape(rawUrl);
  if (!shape.ok) return shape;

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
  const literal = ipv4ToBytes(host) ?? ipv6ToBytes(host.replace(/^\[|\]$/g, ""));
  if (literal) return { ok: true, reason: null }; // already range-checked above

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch (error) {
    return { ok: false, reason: `could not resolve "${host}": ${error instanceof Error ? error.message : String(error)}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `"${host}" resolved to no address` };
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, reason: `"${host}" resolves to a private or reserved address (${address})` };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchedPage {
  status: number | null;
  body: string | null;
  error: string | null;
}

/** Reads at most `limit` bytes from a response body. */
async function readCappedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - total;
      if (remaining <= 0) break;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
      if (total >= limit) break;
    }
  } finally {
    // Stop the socket: the rest of the body is not wanted.
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Fetches one URL, following redirects by hand.
 *
 * Every hop is re-validated (`checkUrlSafety`), the hop count is capped, the
 * request has a deadline, and the body is capped — so a merchant-supplied link
 * can neither walk the checker into the private network nor exhaust memory.
 */
export async function fetchPage(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  lookup: LookupFn = defaultLookup,
): Promise<FetchedPage> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safety = await checkUrlSafety(current, lookup);
    if (!safety.ok) {
      return { status: null, body: null, error: `refused: ${safety.reason ?? "the URL was not allowed"}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(current, {
        signal: controller.signal,
        headers: {
          "user-agent": "IndiaLegalMetrologyMRP/1.0 (policy link check)",
          accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { status: response.status, body: null, error: "the redirect target was not a valid URL" };
        }
        // Drain the redirect body so the socket is released.
        await response.arrayBuffer().catch(() => undefined);
        current = next;
        continue;
      }

      const body = await readCappedBody(response, MAX_BODY_BYTES);
      return { status: response.status, body, error: null };
    } catch (error) {
      return {
        status: null,
        body: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    status: null,
    body: null,
    error: `refused: more than ${MAX_REDIRECTS} redirects`,
  };
}

/**
 * Checks every link that is filled in. Returns a check per policy key; keys with
 * written text instead of a link are left out (text is self-contained and the
 * rule accepts it).
 */
export async function checkPolicyLinks(
  options: CheckPolicyLinksOptions,
): Promise<Record<string, PolicyLinkCheck>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lookup = options.lookup ?? defaultLookup;
  const now = options.now ?? new Date();
  const checks: Record<string, PolicyLinkCheck> = {};

  for (const field of POLICY_FIELDS) {
    const urlKey = `${field.key}Url` as keyof ShopRecord;
    const raw = options.shop[urlKey];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const url = resolvePolicyUrl(raw, options.shopDomain);
    const page = await fetchPage(url, fetchImpl, timeoutMs, lookup);

    const okStatus = page.status !== null && page.status >= 200 && page.status < 300;
    const body = page.body ?? "";
    const looksEmpty = body.trim().length < 200;
    const looksSuspicious = SUSPICIOUS_MARKERS.some((marker) =>
      body.toLowerCase().includes(marker),
    );

    checks[field.key] = {
      url,
      ok: okStatus && !looksEmpty && !looksSuspicious,
      status: page.status,
      checkedAt: now,
      contentSuspect: okStatus && (looksEmpty || looksSuspicious),
      error:
        page.error ??
        (okStatus ? (looksEmpty ? "the page looked empty" : looksSuspicious ? "the page looked like an error or password page" : null) : `HTTP ${page.status ?? "no response"}`),
    };
  }

  return checks;
}

/** One-line summary for the settings screen. */
export function summarisePolicyChecks(checks: Record<string, PolicyLinkCheck>): string {
  const entries = Object.values(checks);
  if (entries.length === 0) return "No policy links to check yet.";
  const failed = entries.filter((check) => !check.ok).length;
  return failed === 0
    ? `All ${entries.length} policy link${entries.length === 1 ? "" : "s"} answered successfully.`
    : `${failed} of ${entries.length} policy link${entries.length === 1 ? "" : "s"} did not answer successfully.`;
}
