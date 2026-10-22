/**
 * WHERE THE FREE USAGE READS GO: the providers, or — for the idle bench and the CI budget only — a fake
 * usage server on THIS machine.
 *
 * Both free reads (`GET /api/oauth/usage`, `GET /backend-api/wham/usage`) carry a login's bearer token,
 * so the place they are sent is a credential boundary. `FY_USAGE_PROBE_ORIGIN` may move them only to a
 * loopback origin: a token can go to its provider or stay on this host, and nowhere else. Anything
 * that is not a plain `http(s)://` loopback origin — another host, a path, credentials in the URL — is
 * refused, and the reads go to the providers as if it were unset.
 */

/** The provider endpoints, as the probes name them. */
export interface UsageProbeUrls {
  readonly anthropic: string;
  readonly codex: string;
}

const ANTHROPIC_PATH = '/api/oauth/usage';
const CODEX_PATH = '/backend-api/wham/usage';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The usage endpoints `FY_USAGE_PROBE_ORIGIN` points at, or `undefined` for the providers' own —
 * when it is unset, blank, or anything but a loopback origin.
 */
export function usageProbeUrls(raw: string | undefined): UsageProbeUrls | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const bare = url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  const rootOnly = url.pathname === '/' || url.pathname === '';
  if (!(url.protocol === 'http:' || url.protocol === 'https:') || !bare || !rootOnly) return undefined;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return { anthropic: `${url.origin}${ANTHROPIC_PATH}`, codex: `${url.origin}${CODEX_PATH}` };
}
