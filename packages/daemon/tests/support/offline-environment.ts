/**
 * EVERY TEST TIER RUNS OFFLINE. Preloaded by each `bunfig.*.toml`, before any test file.
 *
 * A booted `fyd` phones out on its own: it follows the published model catalog
 * (`https://ferretry.pages.dev/catalog/…`, docs/model-catalog.md) and asks the hosted relay directory
 * which carrier is advertised. A test must never reach either, so these defaults switch both off for
 * this process and for every child that inherits its environment — the fixtures that spawn `fy`/`fyd`
 * pass `process.env` on. A test that wants one of them sets the variable itself; that wins.
 *
 * THE GUARD. In-process `fetch` to a Ferretry-hosted origin is refused outright, so a code path that
 * forgets the switch fails loudly in the test that took it rather than quietly reaching production.
 */
export const OFFLINE_TEST_ENVIRONMENT = {
  FY_MODEL_CATALOG: 'off',
  FY_RELAY_DIRECTORY_ORIGIN: 'off',
} as const;

for (const [name, value] of Object.entries(OFFLINE_TEST_ENVIRONMENT)) process.env[name] ??= value;

/** Hosts a test may never reach: the hosted app and the hosted relay. */
export const FORBIDDEN_TEST_HOST =
  /(^|\.)ferretry\.pages\.dev$|(^|\.)ferretry-hosted-relay\.[a-z0-9-]+\.workers\.dev$/u;

const realFetch = globalThis.fetch;
const guarded = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const href = input instanceof Request ? input.url : String(input);
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    // A relative or malformed address cannot be one of the hosted origins; the real fetch says why.
  }
  if (FORBIDDEN_TEST_HOST.test(host))
    return Promise.reject(new TypeError(`tests run offline: refusing to reach ${host} (offline-environment.ts)`));
  return realFetch(input, init);
};
globalThis.fetch = Object.assign(guarded, realFetch) as typeof fetch;
