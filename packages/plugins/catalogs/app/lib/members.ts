/**
 * THIS BROWSER AS A CATALOG MEMBER: one controller per document, over the member keys in IndexedDB (`fy-catalogs`), the
 * shell's member transport (fail closed when it offers none), the browser's passkeys and its WebCrypto. Built on first
 * use, so a page that never shares anything opens no database.
 */

import { WebCryptoRelayCrypto } from '@ferretry/app';
import { SharedController } from '../features/shared/shared-controller.ts';
import { IndexedDbMemberKeyStore, mintMemberKeys, webCryptoMemberKeyGenerator } from './member-keys.ts';
import { currentMemberTransport } from './member-transport.ts';

let controller: SharedController | undefined;

/**
 * How this browser is named on a publisher's People list: "Browser" and a random suffix, so one person's devices can be
 * told apart when it is time to revoke one. GAP(access): today also names the user agent (Access's device naming).
 */
export function memberClientName(random: (length: number) => Uint8Array): string {
  return `Browser ${Array.from(random(2), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function sharedMembers(): SharedController {
  controller ??= (() => {
    const crypto = new WebCryptoRelayCrypto();
    return new SharedController({
      keys: new IndexedDbMemberKeyStore(),
      mint: async () => await mintMemberKeys(webCryptoMemberKeyGenerator()),
      join: async options => await currentMemberTransport(() => crypto).join(options),
      joinOptions: async options => await currentMemberTransport(() => crypto).joinOptions(options),
      openClient: async subscription => await currentMemberTransport(() => crypto).openClient(subscription),
      credentials: navigator.credentials,
      origin: globalThis.location.origin,
      crypto,
      now: () => new Date(),
      clientName: () => memberClientName(length => crypto.randomBytes(length)),
    });
  })();
  return controller;
}
