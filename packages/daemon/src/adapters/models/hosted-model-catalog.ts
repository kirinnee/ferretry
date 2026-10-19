/**
 * The hosted app's files, read for the published model catalog (docs/model-catalog.md § Live updates):
 * `catalog/version.json`, and — only when its version differs — the catalog and the signed release list
 * that vouches for it.
 *
 * ONE PLAIN GET PER FILE: no credential, no cookie, no retry, `cache: 'no-store'` so a stale copy never
 * hides a new version, and a short timeout so a hosted app that is down costs a check, not a boot. It
 * NEVER THROWS: an unreachable origin answers `undefined`, which the service records as `unreachable`
 * and keeps what it holds.
 */
import type { Bytes, ModelCatalogFetchPort } from '../../lib/index.ts';

/** The narrow slice of `fetch` this read needs, injected so no suite dials out. */
export type ModelCatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Long enough for a slow link, short enough that a down host never holds anything up. */
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 8_000;

export class HostedModelCatalog implements ModelCatalogFetchPort {
  private readonly fetcher: ModelCatalogFetch;

  constructor(
    /** The hosted app's origin: `https://…`, or `http://` to this machine for a test. */
    private readonly origin: string,
    fetcher?: ModelCatalogFetch,
    private readonly timeoutMs = MODEL_CATALOG_FETCH_TIMEOUT_MS,
  ) {
    // Wrapped rather than stored bare: a builtin kept as a value takes its holder as the receiver.
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  async get(path: string): Promise<{ readonly status: number; readonly bytes: Bytes } | undefined> {
    try {
      const response = await this.fetcher(new URL(path, `${this.origin.replace(/\/+$/u, '')}/`).toString(), {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch {
      return undefined;
    }
  }
}
