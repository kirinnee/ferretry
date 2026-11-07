/**
 * The hosted app's files, read for the published model catalog (docs/model-catalog.md § Live updates):
 * `catalog/version.json`, and — only when its version differs — the catalog and the signed release list
 * that vouches for it.
 *
 * ONE PLAIN GET PER FILE through the kernel's fetch port: no credential, no cookie, no retry, `cache: 'no-store'` so
 * a stale copy never hides a new version, and a short timeout so a hosted app that is down costs a check, not a boot.
 * It NEVER THROWS: an unreachable origin answers `undefined`, which the service records as `unreachable` and keeps
 * what it holds.
 */
import type { Clock, FetchPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { Bytes, ModelCatalogFetchPort } from '../../lib/models/published.ts';

/** Long enough for a slow link, short enough that a down host never holds anything up. */
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 8_000;

export class HostedModelCatalog implements ModelCatalogFetchPort {
  constructor(
    /** The hosted app's origin: `https://…`, or `http://` to this machine for a test. */
    private readonly origin: string,
    private readonly fetchPort: FetchPort,
    private readonly clock: Pick<Clock, 'after'>,
    private readonly timeoutMs = MODEL_CATALOG_FETCH_TIMEOUT_MS,
  ) {}

  async get(path: string): Promise<{ readonly status: number; readonly bytes: Bytes } | undefined> {
    const controller = new AbortController();
    const cancel = this.clock.after(milliseconds(this.timeoutMs), () => {
      controller.abort();
    });
    try {
      const response = await this.fetchPort.request(new URL(path, `${this.origin.replace(/\/+$/u, '')}/`).toString(), {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch {
      return undefined;
    } finally {
      cancel();
    }
  }
}
