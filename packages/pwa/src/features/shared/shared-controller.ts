/**
 * Everything a catalog MEMBER does in this browser, behind injected ports: join a publisher from a share
 * link, add the one passkey inside the window, unlock, read what is shared, open an item, leave.
 *
 * THE RULES THIS ENFORCES, each of them a test:
 *
 * - The keys for a publisher are minted per publisher and held in memory until the publisher answers
 *   `joined`. A refused or unreachable join leaves nothing in the key store.
 * - The publisher is proved against the link's fingerprint before the code is sent (the session refuses to
 *   key a channel to anything else), and a `joined` that names another publisher is not believed.
 * - A refused key (`4403`, or `401` on an open session) is MARKED, never deleted. Only the person's own tap
 *   (`forget`, `leave`) removes a key.
 * - Nothing is shown before it verifies: every manifest and every item is checked against the publisher.
 */

import {
  parseShareFragment,
  SHARED_CATALOG_FILE_FORMAT,
  type SharedCatalogItem,
  type SharedCatalogManifest,
  type SharedCatalogManifestEntry,
  type SharedMe,
  type SharedRedeemResponse,
  type ShareLinkSeed,
  type SignedCatalogManifest,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { type RelayCrypto, verifyCatalogItem, verifySignedCatalogManifest } from '@ferretry/relay';
import type { MemberClient } from '../../lib/member-client.ts';
import type { MemberKeyStore, MemberSubscription, MintedMemberKeys } from '../../lib/member-keys.ts';
import { assertPasskey, type CredentialsPort, createPasskey } from '../../lib/passkeys.ts';
import type { JoinResult } from '../../lib/relay-join.ts';
import type { OpenedCatalogFile } from '../catalogs/catalog-install-model.ts';
import {
  leavePublisher,
  passkeyOptions,
  readMe,
  readSharedItem,
  readSharedManifest,
  redeemShare,
  registerPasskey,
  unlockMember,
  unlockOptions,
} from './shared-api.ts';
import {
  isKeyRefused,
  JOIN_REFUSED_SENTENCE,
  NOT_A_SHARE_LINK,
  NOT_SHOWN_SENTENCE,
  type Problem,
  problemFor,
  redeemRefusal,
} from './shared-model.ts';

/** An item that did not verify against its signed manifest: its sentence is shown, the item never is. */
class ItemNotVerifiedError extends Error {}

export interface SharedControllerPorts {
  readonly keys: MemberKeyStore;
  readonly mint: () => Promise<MintedMemberKeys>;
  readonly join: (options: {
    readonly seed: ShareLinkSeed;
    readonly clientName: string;
    readonly keys: MintedMemberKeys;
  }) => Promise<JoinResult>;
  readonly openClient: (subscription: MemberSubscription) => Promise<MemberClient>;
  readonly credentials: CredentialsPort;
  readonly origin: string;
  readonly crypto: RelayCrypto;
  readonly now: () => Date;
  /** What this browser calls itself to a publisher. */
  readonly clientName: () => string;
  /** Whether this browser has passkeys at all; the browser's own answer by default. */
  readonly passkeysSupported?: boolean;
}

/** What a share link in the address bar came to. */
export type BeginResult =
  | { readonly kind: 'invalid'; readonly sentence: string }
  | { readonly kind: 'new'; readonly seed: ShareLinkSeed }
  | { readonly kind: 'known'; readonly seed: ShareLinkSeed; readonly subscription: MemberSubscription };

export type JoinOutcome =
  | { readonly kind: 'joined'; readonly subscription: MemberSubscription }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'unreachable'; readonly sentence: string }
  | { readonly kind: 'unsupported'; readonly sentence: string };

/** One call to a publisher: it worked, the publisher refused the KEY, or it failed for a stated reason. */
export type Attempt<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly problem: Problem };

export interface SharedCatalogView {
  readonly catalogId: string;
  readonly name: string;
  readonly revision: number;
  /** Absent when the manifest did not verify: then `problem` says so and nothing else is shown. */
  readonly signed?: SignedCatalogManifest;
  readonly manifest?: SharedCatalogManifest;
  readonly problem?: string;
}

export interface SharedBrowse {
  readonly me: SharedMe;
  readonly catalogs: readonly SharedCatalogView[];
}

export interface RedeemOutcome {
  readonly kind: 'added' | 'refused';
  readonly response?: SharedRedeemResponse;
  readonly sentence?: string;
}

export class SharedController {
  readonly #ports: SharedControllerPorts;
  readonly #clients = new Map<string, Promise<MemberClient>>();

  constructor(ports: SharedControllerPorts) {
    this.#ports = ports;
  }

  /** Every publisher this browser belongs to, refused ones included. */
  async list(): Promise<readonly MemberSubscription[]> {
    return await this.#ports.keys.list();
  }

  /** Reads a link's fragment and says whether this browser already has a key for that publisher. */
  async begin(fragment: string): Promise<BeginResult> {
    let seed: ShareLinkSeed;
    try {
      seed = parseShareFragment(fragment);
    } catch {
      return { kind: 'invalid', sentence: NOT_A_SHARE_LINK };
    }
    const subscription = await this.#ports.keys.load(seed.daemonId);
    return subscription === undefined ? { kind: 'new', seed } : { kind: 'known', seed, subscription };
  }

  /** Joins a publisher with fresh keys. A key is saved only after `joined`. */
  async join(seed: ShareLinkSeed): Promise<JoinOutcome> {
    let keys: MintedMemberKeys;
    try {
      keys = await this.#ports.mint();
    } catch (error) {
      return { kind: 'unsupported', sentence: error instanceof Error ? error.message : 'This browser cannot join.' };
    }
    const result = await this.#ports.join({ seed, clientName: this.#ports.clientName(), keys });
    if (result.kind === 'refused') return { kind: 'refused', sentence: JOIN_REFUSED_SENTENCE };
    if (result.kind === 'unreachable') {
      return {
        kind: 'unreachable',
        sentence: result.maybeSpentUnheard
          ? 'The link may have been used, but no answer came back. If it does not work again, ask for a new one.'
          : 'Could not reach the publisher. Check you are online, then try again.',
      };
    }
    const { response, carrier } = result;
    if (response.daemonId !== seed.daemonId) return { kind: 'refused', sentence: JOIN_REFUSED_SENTENCE };
    const subscription: MemberSubscription = {
      daemonId: response.daemonId,
      daemonName: response.daemonName,
      daemonUrl: carrier.kind === 'direct' ? carrier.daemonUrl : seed.daemonUrl,
      ownLabel: response.daemonName,
      keyId: response.keyId,
      memberId: response.memberId,
      memberLabel: response.label,
      status: 'active',
      joinedAt: this.#ports.now().toISOString(),
      passkeyWindowEndsAt: response.passkeyWindowEndsAt,
      unlockDays: response.memberUnlockDays,
      carriers: response.carriers,
      publicKey: keys.publicKey,
      boxKey: keys.boxKey,
      signingKey: keys.signingKey,
      boxPrivateKey: keys.boxPrivateKey,
    };
    this.#dropClient(subscription.daemonId);
    await this.#ports.keys.save(subscription);
    return { kind: 'joined', subscription };
  }

  /** The one passkey, made inside the window. */
  async addPasskey(subscription: MemberSubscription): Promise<Attempt<void>> {
    return await this.#attempt(subscription, async client => {
      const options = await passkeyOptions(client, this.#ports.origin);
      const registration = await createPasskey(this.#ports.credentials, options, this.#ports.passkeysSupported);
      await registerPasskey(client, registration);
    });
  }

  /** Unlocks this browser for the publisher's configured days. */
  async unlock(subscription: MemberSubscription): Promise<Attempt<string>> {
    return await this.#attempt(subscription, async client => {
      const options = await unlockOptions(client, this.#ports.origin);
      const assertion = await assertPasskey(this.#ports.credentials, options, this.#ports.passkeysSupported);
      return (await unlockMember(client, assertion)).unlockedUntil;
    });
  }

  /** Spends a share code with the key this browser already has. */
  async redeem(subscription: MemberSubscription, code: string): Promise<Attempt<RedeemOutcome>> {
    return await this.#attempt(subscription, async (client): Promise<RedeemOutcome> => {
      try {
        return { kind: 'added', response: await redeemShare(client, code) };
      } catch (error) {
        if (error instanceof FyHttpError) {
          return { kind: 'refused', sentence: redeemRefusal(error, this.#ports.origin) };
        }
        throw error;
      }
    });
  }

  /** What is shared with this member, each manifest verified before it is returned. */
  async browse(subscription: MemberSubscription): Promise<Attempt<SharedBrowse>> {
    return await this.#attempt(subscription, async client => {
      const me = await readMe(client);
      const catalogs: SharedCatalogView[] = [];
      for (const listed of me.catalogs) {
        catalogs.push(await this.#viewCatalog(client, subscription, listed));
      }
      return { me, catalogs };
    });
  }

  /** One item, fetched at the version the verified manifest lists and verified against it. */
  async openItem(
    subscription: MemberSubscription,
    view: SharedCatalogView,
    entry: SharedCatalogManifestEntry,
  ): Promise<Attempt<{ readonly item: SharedCatalogItem; readonly opened: OpenedCatalogFile }>> {
    const { signed, manifest } = view;
    if (signed === undefined || manifest === undefined) {
      return { kind: 'failed', problem: { kind: 'gone', sentence: NOT_SHOWN_SENTENCE } };
    }
    return await this.#attempt(subscription, async client => {
      const item = await readSharedItem(client, view.catalogId, entry.itemId, entry.version);
      const checked = await verifyCatalogItem(this.#ports.crypto, manifest, item);
      if (!checked.ok) throw new ItemNotVerifiedError(checked.reason);
      return {
        item,
        opened: {
          manifest,
          file: {
            format: SHARED_CATALOG_FILE_FORMAT,
            version: 1,
            exportedAt: this.#ports.now().toISOString(),
            signedManifest: signed,
            items: [item],
          },
        },
      };
    });
  }

  /** Leaves the publisher. The answer is a 200; this browser's key and record are then the person's to drop. */
  async leave(subscription: MemberSubscription): Promise<Attempt<void>> {
    const attempt = await this.#attempt(subscription, async client => await leavePublisher(client));
    if (attempt.kind === 'ok') await this.forget(subscription.daemonId);
    return attempt;
  }

  /** The person's own tap: the key and the record go. */
  async forget(daemonId: string): Promise<void> {
    this.#dropClient(daemonId);
    await this.#ports.keys.forget(daemonId);
  }

  async rename(daemonId: string, ownLabel: string): Promise<boolean> {
    return await this.#ports.keys.rename(daemonId, ownLabel);
  }

  closeAll(): void {
    for (const daemonId of [...this.#clients.keys()]) this.#dropClient(daemonId);
  }

  #dropClient(daemonId: string): void {
    const held = this.#clients.get(daemonId);
    this.#clients.delete(daemonId);
    void held?.then(client => client.close());
  }

  #clientFor(subscription: MemberSubscription): Promise<MemberClient> {
    const held = this.#clients.get(subscription.daemonId);
    if (held !== undefined) return held;
    const opened = this.#ports.openClient(subscription);
    this.#clients.set(subscription.daemonId, opened);
    return opened;
  }

  async #viewCatalog(
    client: MemberClient,
    subscription: MemberSubscription,
    listed: SharedMe['catalogs'][number],
  ): Promise<SharedCatalogView> {
    const base = { catalogId: listed.catalogId, name: listed.name, revision: listed.revision };
    const signed = await readSharedManifest(client, listed.catalogId);
    const verified = await verifySignedCatalogManifest(this.#ports.crypto, signed);
    const trusted =
      verified.ok &&
      verified.value.publisher === subscription.daemonId &&
      verified.value.catalogId === listed.catalogId;
    return trusted ? { ...base, signed, manifest: verified.value } : { ...base, problem: NOT_SHOWN_SENTENCE };
  }

  /** Runs one call; a refused key is marked (never deleted) and said apart from every other failure. */
  async #attempt<T>(
    subscription: MemberSubscription,
    action: (client: MemberClient) => Promise<T>,
  ): Promise<Attempt<T>> {
    try {
      return { kind: 'ok', value: await action(await this.#clientFor(subscription)) };
    } catch (error) {
      if (isKeyRefused(error)) {
        this.#dropClient(subscription.daemonId);
        await this.#ports.keys.markRefused(subscription.daemonId, this.#ports.now().toISOString());
        return { kind: 'refused' };
      }
      if (error instanceof ItemNotVerifiedError) {
        return { kind: 'failed', problem: { kind: 'gone', sentence: error.message } };
      }
      return { kind: 'failed', problem: problemFor(error, this.#ports.origin) };
    }
  }
}
