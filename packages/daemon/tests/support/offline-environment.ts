/**
 * EVERY TEST TIER RUNS OFFLINE. Preloaded by each `bunfig.*.toml`, before any test file.
 *
 * A booted `fyd` phones out on its own (and reads Ollama on this machine, which a developer may be running): it follows the published model catalog
 * (`https://ferretry.pages.dev/catalog/…`, docs/model-catalog.md), asks the hosted relay directory
 * which carrier is advertised, and — compiled — checks GitHub for a newer release. A test must never
 * reach any of them, so these defaults switch all of them off for this process and for every child that
 * inherits its environment — the fixtures that spawn `fy`/`fyd` pass `process.env` on. A test that
 * wants one of them sets the variable itself; that wins.
 *
 * THE GUARD. In-process `fetch` to one of those hosts is refused outright, so a code path that
 * forgets the switch fails loudly in the test that took it rather than quietly reaching production.
 */
export const OFFLINE_TEST_ENVIRONMENT = {
  FY_MODEL_CATALOG: 'off',
  FY_RELAY_DIRECTORY_ORIGIN: 'off',
  FY_UPDATE_CHECK: 'off',
  FY_LOCAL_MODELS: 'off',
} as const;

for (const [name, value] of Object.entries(OFFLINE_TEST_ENVIRONMENT)) process.env[name] ??= value;

/** Hosts a test may never reach: the hosted app, the hosted relay, and GitHub's release API. */
export const FORBIDDEN_TEST_HOST =
  /(^|\.)ferretry\.pages\.dev$|^api\.github\.com$|(^|\.)ferretry-hosted-relay\.[a-z0-9-]+\.workers\.dev$/u;

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
