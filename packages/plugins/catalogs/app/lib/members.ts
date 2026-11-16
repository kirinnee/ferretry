/**
 * THIS BROWSER AS A CATALOG MEMBER: one controller per document, over the member keys in IndexedDB (`fy-catalogs`), the
 * shell's member transport (fail closed when it offers none), the browser's passkeys and its WebCrypto. Built on first
 * use, so a page that never shares anything opens no database.
 */

import { browserDeviceName, WebCryptoRelayCrypto } from '@ferretry/app';
import { SharedController } from '../features/shared/shared-controller.ts';
import { IndexedDbMemberKeyStore, mintMemberKeys, webCryptoMemberKeyGenerator } from './member-keys.ts';
import { currentMemberTransport } from './member-transport.ts';

let controller: SharedController | undefined;

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
      // What a person would call this browser ("Chrome on macOS · K7Q2"): the shell's one device naming, which Access
      // also pairs with, so one person's browsers can be told apart on a publisher's People list.
      clientName: browserDeviceName,
    });
  })();
  return controller;
}
