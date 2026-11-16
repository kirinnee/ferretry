import type { LinkStoreClient, LinkStoreLocator, LinkStoreSite } from '../lib/catalog-links/ports.ts';
import { linkStoreSiteProblem } from '../lib/catalog-links/store-origin.ts';

/** `catalogs.linkStore` in `config/daemon.json`, as the config schema parses it. */
export type LinkStoreSetting =
  | { readonly source: 'discovery' }
  | { readonly url: string }
  | { readonly enabled: false };

const OFF = 'Download links are turned off on this machine (catalogs.linkStore).';
const NO_DIRECTORY =
  'This machine has no link store to ask: the relay directory is off. Set catalogs.linkStore.url to use your own.';
const NOT_HTTPS =
  'The link store address is not a plain https address, so no link can be made through it. Check the relay directory or catalogs.linkStore.url.';
const DOWN = 'The link store is not taking new links right now. Try again later.';

/**
 * Decides which store the NEXT link goes to: the configured one, or the one the relay directory origin serves. It
 * asks that store whether it is taking links (`GET /v1/link-store`, no redirect) and answers its origin or why there
 * is none. A link remembers its origin; this is never asked again for a link that exists.
 */
export class ConfiguredLinkStoreLocator implements LinkStoreLocator {
  constructor(
    private readonly setting: () => LinkStoreSetting,
    private readonly directoryOrigin: () => string | undefined,
    private readonly client: Pick<LinkStoreClient, 'available'>,
  ) {}

  async locate(): Promise<LinkStoreSite> {
    const setting = this.setting();
    if ('enabled' in setting) return { kind: 'unavailable', reason: OFF };
    const selfHosted = 'url' in setting;
    const origin = 'url' in setting ? setting.url : this.directoryOrigin();
    if (origin === undefined) return { kind: 'unavailable', reason: NO_DIRECTORY };
    // Signed uploads and deletes go here, and a spoofed answer to a delete would read as "turned off".
    if (linkStoreSiteProblem(origin) !== null) return { kind: 'unavailable', reason: NOT_HTTPS };
    const taking = await this.client.available(origin);
    return taking
      ? { kind: 'ready', origin: new URL(origin).origin, selfHosted }
      : { kind: 'unavailable', reason: DOWN };
  }
}
