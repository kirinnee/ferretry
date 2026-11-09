import type { LinkStoreSetting } from './link-store-locator.ts';

/** The host (with a non-default port) of an address, or nothing when it is not an address. */
function hostOf(address: string): string[] {
  try {
    return [new URL(address).host];
  } catch {
    return [];
  }
}

/**
 * The hosts the kernel may reach for the link store (the manifest's `{ resolver: 'link-store' }` network entry): the
 * store the next link goes to (the configured address, or the relay directory's origin), plus every store an existing
 * link remembers, so a link made before a setting changed can still be turned off. The kernel asks with no request
 * data at each outbound call, so the remembered origins live in memory and are refreshed whenever `links.json` is
 * read or written. A machine with download links turned off grants no new store, only the remembered ones.
 */
export class LinkStoreHosts {
  #remembered: readonly string[] = [];

  constructor(
    private readonly setting: () => LinkStoreSetting,
    private readonly directoryOrigin: () => string | undefined,
  ) {}

  /** Replaces the remembered stores with the origins of the links now on file. */
  remember(origins: readonly string[]): void {
    this.#remembered = origins.flatMap(hostOf);
  }

  resolve(): readonly string[] {
    const setting = this.setting();
    const next = 'enabled' in setting ? undefined : 'url' in setting ? setting.url : this.directoryOrigin();
    return [...new Set([...(next === undefined ? [] : hostOf(next)), ...this.#remembered])];
  }
}
