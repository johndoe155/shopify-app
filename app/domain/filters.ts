/**
 * Client-safe filter sentinels.
 *
 * These live in `domain/` rather than next to the loader code because a React
 * Router route may only import *values* from server modules inside `loader` and
 * `action`. Importing the sentinel from `services/report.server` into the
 * component pulled the whole server module into the browser bundle and broke
 * the production build.
 */

/** Dashboard filter value that lists products with unresolved (inconclusive) checks. */
export const INCONCLUSIVE_FILTER = "__inconclusive";
