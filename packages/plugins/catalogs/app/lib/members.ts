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

/** GAP(access): today names this browser from its user agent and a random suffix (Access's device naming); a plain name is used. */
const CLIENT_NAME = 'Browser';

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
      clientName: () => CLIENT_NAME,
    });
  })();
  return controller;
}
