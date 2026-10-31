/**
 * Everything a member does in this browser, behind fake ports: a key saved only after `joined`, a
 * refusal that marks and never deletes, and nothing shown before it verifies.
 */

import { beforeAll, describe, it } from 'bun:test';
import {
  CatalogShareCodeSchema,
  formatShareFragment,
  type MemberJoinedResponse,
  type SharedCatalogItem,
  type ShareLinkSeed,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import type { z } from 'zod';
import {
  type SharedBrowse,
  SharedController,
  type SharedControllerPorts,
} from '../../../../src/features/shared/shared-controller.ts';
import {
  JOIN_REFUSED_SENTENCE,
  NOT_A_SHARE_LINK,
  NOT_SHOWN_SENTENCE,
} from '../../../../src/features/shared/shared-model.ts';
import { MemberRefusedError, MemberUnreachableError, type MemberClient } from '../../../../src/lib/member-client.ts';
import { MemberKeyUnsupportedError, type MemberSubscription } from '../../../../src/lib/member-keys.ts';
import type { CredentialsPort } from '../../../../src/lib/passkeys.ts';
import type { JoinResult } from '../../../../src/lib/relay-join.ts';
import { crypto, newIdentity, SKILL_ITEM_ID, signedFile, skillItem } from '../../../support/catalog-files.ts';
import { MemoryMemberKeyStore, testMemberKeys, testSubscription } from '../../../support/member-keys.ts';

const NOW = new Date('2026-10-31T10:00:00.000Z');
const ORIGIN = 'https://app.ferretry.test';
const CODE = CatalogShareCodeSchema.parse('fy_share_FAKEFAKEFAKEFAKEFAKEFA');
const buffer = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;
const http = (code: string, status = 409) => new FyHttpError('refused', status, code);

let publisher: DaemonIdentity;
let seed: ShareLinkSeed;
let item: SharedCatalogItem;

beforeAll(async () => {
  publisher = await newIdentity();
  seed = { daemonUrl: 'https://studio.example.test', daemonId: publisher.daemonId, code: CODE };
  item = skillItem(publisher.daemonId);
});

const credentials = (): CredentialsPort => ({
  create: async () =>
    ({
      type: 'public-key',
      rawId: buffer(0xaa),
      response: { clientDataJSON: buffer(0x7b), attestationObject: buffer(0xa0) },
    }) as unknown as Credential,
  get: async () =>
    ({
      type: 'public-key',
      rawId: buffer(0xaa),
      response: { clientDataJSON: buffer(0x7b), authenticatorData: buffer(1), signature: buffer(2) },
    }) as unknown as Credential,
});

type Handler = (init: RequestInit | undefined) => unknown;

class FakeClient implements MemberClient {
  closed = 0;
  readonly seen: string[] = [];
  constructor(private readonly handlers: Readonly<Record<string, Handler>>) {}
  async request<T extends z.ZodType>(path: string, _schema: T, init?: RequestInit): Promise<z.infer<T>> {
    const key = `${init?.method ?? 'GET'} ${path}`;
    this.seen.push(key);
    const handler = this.handlers[key];
    if (handler === undefined) throw new Error(`no handler for ${key}`);
    return handler(init) as z.infer<T>;
  }
  close(): void {
    this.closed += 1;
  }
}

const joinedResponse = (overrides: Partial<MemberJoinedResponse> = {}): MemberJoinedResponse => ({
  memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
  keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
  label: 'Alice',
  daemonId: publisher.daemonId,
  daemonName: 'Studio',
  catalogCount: 1,
  carriers: [],
  passkeyWindowEndsAt: '2026-10-31T10:10:00.000Z',
  memberUnlockDays: 30,
  ...overrides,
});

interface Rig {
  readonly controller: SharedController;
  readonly keys: MemoryMemberKeyStore;
  readonly opened: MemberSubscription[];
  readonly joins: number[];
  readonly clients: FakeClient[];
}

const rig = (
  handlers: Readonly<Record<string, Handler>> = {},
  overrides: Omit<Partial<SharedControllerPorts>, 'join'> & { join?: JoinResult } = {},
): Rig => {
  const keys = new MemoryMemberKeyStore();
  const opened: MemberSubscription[] = [];
  const joins: number[] = [];
  const clients: FakeClient[] = [];
  const { join: joinResult, ...ports } = overrides;
  const controller = new SharedController({
    keys,
    mint: testMemberKeys,
    join: async () => {
      joins.push(1);
      return (
        joinResult ?? {
          kind: 'joined',
          response: joinedResponse(),
          carrier: { kind: 'direct', daemonUrl: seed.daemonUrl },
        }
      );
    },
    openClient: async subscription => {
      opened.push(subscription);
      const client = new FakeClient(handlers);
      clients.push(client);
      return client;
    },
    credentials: credentials(),
    origin: ORIGIN,
    crypto,
    now: () => NOW,
    clientName: () => 'Alice’s phone',
    passkeysSupported: true,
    ...ports,
  });
  return { controller, keys, opened, joins, clients };
};

describe('begin', () => {
  it('should say a fragment that is not a share link is not one, and touch nothing', async () => {
    const { controller, keys } = rig();
    const result = await controller.begin('v1;url=nope');
    should(result).match({ kind: 'invalid', sentence: NOT_A_SHARE_LINK });
    should(keys.saved).be.empty();
  });

  it('should read a new publisher, and a known one by its fingerprint', async () => {
    const { controller, keys } = rig();
    const fragment = `#${formatShareFragment(seed)}`;
    should(await controller.begin(fragment)).match({ kind: 'new', seed: { daemonId: publisher.daemonId } });
    const known = await testSubscription(publisher.daemonId);
    keys.subscriptions.set(known.daemonId, known);
    should(await controller.begin(fragment)).match({ kind: 'known', subscription: { keyId: known.keyId } });
  });
});

describe('join', () => {
  it('should save the keys only after the publisher said joined, under the verified fingerprint', async () => {
    const { controller, keys } = rig();
    const outcome = await controller.join(seed);
    should(outcome.kind).equal('joined');
    should(keys.saved).deepEqual([publisher.daemonId]);
    const saved = keys.subscriptions.get(publisher.daemonId);
    should(saved).match({
      ownLabel: 'Studio',
      memberLabel: 'Alice',
      status: 'active',
      daemonUrl: seed.daemonUrl,
      joinedAt: NOW.toISOString(),
      unlockDays: 30,
    });
    should(saved?.signingKey).be.instanceof(CryptoKey);
  });

  it('should remember the address that answered when it was the direct one, else the link’s', async () => {
    const direct = rig(
      {},
      {
        join: {
          kind: 'joined',
          response: joinedResponse(),
          carrier: { kind: 'direct', daemonUrl: 'https://other.test' },
        },
      },
    );
    await direct.controller.join(seed);
    should(direct.keys.subscriptions.get(publisher.daemonId)?.daemonUrl).equal('https://other.test');

    const relayed = rig(
      {},
      {
        join: {
          kind: 'joined',
          response: joinedResponse(),
          carrier: { kind: 'relay', relayUrl: 'wss://relay.ferretry.test', operator: 'hosted' },
        },
      },
    );
    await relayed.controller.join(seed);
    should(relayed.keys.subscriptions.get(publisher.daemonId)?.daemonUrl).equal(seed.daemonUrl);
  });

  it('should save nothing and say the one refusal sentence when the publisher refuses', async () => {
    const { controller, keys } = rig({}, { join: { kind: 'refused', maybeSpentUnheard: false } });
    should(await controller.join(seed)).match({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE });
    should(keys.saved).be.empty();
  });

  it('should not believe a publisher that answers as a different fingerprint', async () => {
    const other = await newIdentity();
    const { controller, keys } = rig(
      {},
      {
        join: {
          kind: 'joined',
          response: joinedResponse({ daemonId: other.daemonId }),
          carrier: { kind: 'direct', daemonUrl: seed.daemonUrl },
        },
      },
    );
    should(await controller.join(seed)).match({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE });
    should(keys.saved).be.empty();
  });

  it('should save nothing when no carrier answers, and warn if the code may be spent', async () => {
    const plain = rig({}, { join: { kind: 'unreachable', maybeSpentUnheard: false, tried: 2 } });
    const spent = rig({}, { join: { kind: 'unreachable', maybeSpentUnheard: true, tried: 2 } });
    const first = await plain.controller.join(seed);
    const second = await spent.controller.join(seed);
    should(first.kind).equal('unreachable');
    should(second.kind).equal('unreachable');
    should((second as { sentence: string }).sentence).not.equal((first as { sentence: string }).sentence);
    should(plain.keys.saved).be.empty();
    should(spent.keys.saved).be.empty();
  });

  it('should send nothing when this browser cannot make the keys', async () => {
    const unsupported = rig(
      {},
      {
        mint: async () => {
          throw new MemberKeyUnsupportedError();
        },
      },
    );
    const outcome = await unsupported.controller.join(seed);
    should(outcome.kind).equal('unsupported');
    should(unsupported.joins).be.empty();

    const odd = rig(
      {},
      {
        mint: async () => {
          throw 'nope';
        },
      },
    );
    should(await odd.controller.join(seed)).match({ kind: 'unsupported', sentence: 'This browser cannot join.' });
  });

  it('should close a pooled client for the publisher it replaces', async () => {
    const stale = await testSubscription(publisher.daemonId, { status: 'refused' });
    const { controller, clients } = rig({
      'GET /v1/shared/me': () => {
        throw new MemberUnreachableError(1);
      },
    });
    await controller.browse(stale);
    should(clients[0]?.closed).equal(0);
    await controller.join(seed);
    await Promise.resolve();
    should(clients[0]?.closed).equal(1);
  });
});

describe('passkey and unlock', () => {
  it('should create the passkey and register it', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, clients } = rig({
      'POST /v1/shared/passkeys/options': () => ({
        challenge: 'AQID',
        rp: { id: 'app.ferretry.test', name: 'Ferretry' },
        user: { id: 'CQk', name: 'Alice', displayName: 'Alice' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        excludeCredentials: [],
      }),
      'POST /v1/shared/passkeys': () => ({ id: 'AA', origin: ORIGIN, createdAt: NOW.toISOString() }),
    });
    should((await controller.addPasskey(sub)).kind).equal('ok');
    should(clients[0]?.seen).deepEqual(['POST /v1/shared/passkeys/options', 'POST /v1/shared/passkeys']);
  });

  it('should say the window is closed in a sentence, and not mark the key', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, keys } = rig({
      'POST /v1/shared/passkeys/options': () => {
        throw http('member_registration_closed');
      },
    });
    keys.subscriptions.set(sub.daemonId, sub);
    const result = await controller.addPasskey(sub);
    should(result).match({ kind: 'failed', problem: { kind: 'window-closed' } });
    should(keys.refused).be.empty();
  });

  it('should mark a refused key, keep it, and say it was refused', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, keys, clients } = rig({
      'POST /v1/shared/passkeys/options': () => {
        throw new MemberRefusedError();
      },
    });
    keys.subscriptions.set(sub.daemonId, sub);
    should((await controller.addPasskey(sub)).kind).equal('refused');
    should(keys.refused).deepEqual([publisher.daemonId]);
    should(keys.forgotten).be.empty();
    should(keys.subscriptions.get(publisher.daemonId)).match({ status: 'refused', refusedAt: NOW.toISOString() });
    await Promise.resolve();
    should(clients[0]?.closed).equal(1);
  });

  it('should unlock with the passkey and return when it ends', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller } = rig({
      'POST /v1/shared/unlock/options': () => ({
        challenge: 'AQID',
        rpId: 'app.ferretry.test',
        allowCredentials: [{ type: 'public-key', id: 'qg' }],
        timeout: 60000,
      }),
      'POST /v1/shared/unlock': () => ({ unlockedUntil: '2026-11-30T10:00:00.000Z' }),
    });
    should(await controller.unlock(sub)).match({ kind: 'ok', value: '2026-11-30T10:00:00.000Z' });
  });
});

describe('redeem', () => {
  const redeemWith = async (handler: Handler) => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller } = rig({ 'POST /v1/shared/redeem': handler });
    return await controller.redeem(sub, CODE);
  };

  it('should add the catalogs a code gives', async () => {
    const result = await redeemWith(() => ({ added: [{ catalogId: item.catalogId, name: 'Tools' }] }));
    should(result).match({ kind: 'ok', value: { kind: 'added', response: { added: [{ name: 'Tools' }] } } });
  });

  it('should answer a code made for someone else, or for a new person, with a sentence each', async () => {
    const other = await redeemWith(() => {
      throw http('share_other_member');
    });
    const fresh = await redeemWith(() => {
      throw http('share_new_member');
    });
    should(other).match({ kind: 'ok', value: { kind: 'refused', sentence: /someone else/u } });
    should(fresh).match({ kind: 'ok', value: { kind: 'refused', sentence: /already a member/u } });
  });

  it('should let any other error through as a failure', async () => {
    const result = await redeemWith(() => {
      throw new MemberUnreachableError(1);
    });
    should(result).match({ kind: 'failed', problem: { kind: 'unreachable' } });
  });
});

describe('browse and openItem', () => {
  const me = (catalogId: string) => ({
    memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
    keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
    label: 'Alice',
    daemonId: publisher.daemonId,
    daemonName: 'Studio',
    catalogs: [{ catalogId, name: "Kirin's catalog", revision: 1 }],
    carriers: [],
    unlockExpiresAt: '2026-11-30T10:00:00.000Z',
    passkeys: 1,
  });

  const browsed = async (signedOf: () => unknown, sub?: MemberSubscription) => {
    const file = await signedFile(publisher, [item]);
    const subscription = sub ?? (await testSubscription(publisher.daemonId));
    const handlers = {
      'GET /v1/shared/me': () => me(item.catalogId),
      [`GET /v1/shared/catalogs/${item.catalogId}/manifest`]: () => signedOf() ?? file.signedManifest,
      [`GET /v1/shared/catalogs/${item.catalogId}/items/${SKILL_ITEM_ID}/1`]: () => item,
    };
    const rigged = rig(handlers);
    const result = await rigged.controller.browse(subscription);
    return { file, subscription, result, ...rigged };
  };

  it('should show a catalog only after its manifest verifies', async () => {
    const { result } = await browsed(() => undefined);
    const value = (result as { value: SharedBrowse }).value;
    should(value.catalogs[0]?.manifest?.publisher).equal(publisher.daemonId);
    should(value.catalogs[0]?.problem).be.undefined();
  });

  it('should not show a manifest signed by a publisher other than the one joined', async () => {
    const other = await newIdentity();
    const otherFile = await signedFile(other, [skillItem(other.daemonId)]);
    const { result } = await browsed(() => otherFile.signedManifest);
    const view = (result as { value: SharedBrowse }).value.catalogs[0];
    should(view?.problem).equal(NOT_SHOWN_SENTENCE);
    should(view?.manifest).be.undefined();
  });

  it('should not show a manifest for a different catalog than the one listed', async () => {
    const file = await signedFile(publisher, [item]);
    const subscription = await testSubscription(publisher.daemonId);
    const { controller } = rig({
      'GET /v1/shared/me': () => me(`cat_${'z'.repeat(22)}`),
      [`GET /v1/shared/catalogs/cat_${'z'.repeat(22)}/manifest`]: () => file.signedManifest,
    });
    const result = await controller.browse(subscription);
    should((result as { value: SharedBrowse }).value.catalogs[0]?.problem).equal(NOT_SHOWN_SENTENCE);
  });

  it('should fetch an item at the listed version, verify it, and hand back a file for the install preview', async () => {
    const { controller, result, subscription, file } = await browsed(() => undefined);
    const view = (result as { value: SharedBrowse }).value.catalogs[0];
    if (view?.manifest === undefined) throw new Error('catalog was not shown');
    const entry = view.manifest.items[0];
    if (entry === undefined) throw new Error('no entry');
    const opened = await controller.openItem(subscription, view, entry);
    should(opened.kind).equal('ok');
    const value = (opened as { value: { opened: { file: { items: unknown[]; signedManifest: unknown } } } }).value;
    should(value.opened.file.signedManifest).deepEqual(file.signedManifest);
    should(value.opened.file.items).have.length(1);
  });

  it('should never show an item that does not verify against the manifest', async () => {
    const file = await signedFile(publisher, [item]);
    const subscription = await testSubscription(publisher.daemonId);
    const tampered = { ...item, summary: 'Something else' };
    const { controller } = rig({
      'GET /v1/shared/me': () => me(item.catalogId),
      [`GET /v1/shared/catalogs/${item.catalogId}/manifest`]: () => file.signedManifest,
      [`GET /v1/shared/catalogs/${item.catalogId}/items/${SKILL_ITEM_ID}/1`]: () => tampered,
    });
    const browse = await controller.browse(subscription);
    const view = (browse as { value: SharedBrowse }).value.catalogs[0];
    const entry = view?.manifest?.items[0];
    if (view === undefined || entry === undefined) throw new Error('catalog was not shown');
    const opened = await controller.openItem(subscription, view, entry);
    should(opened).match({ kind: 'failed', problem: { kind: 'gone' } });
  });

  it('should refuse to open an item of a catalog that was not shown', async () => {
    const { controller } = rig();
    const subscription = await testSubscription(publisher.daemonId);
    const file = await signedFile(publisher, [item]);
    const entry = await import('@ferretry/relay').then(relay =>
      relay.verifySignedCatalogManifest(crypto, file.signedManifest),
    );
    if (!entry.ok) throw new Error('did not verify');
    const first = entry.value.items[0];
    if (first === undefined) throw new Error('no entry');
    const result = await controller.openItem(
      subscription,
      { catalogId: item.catalogId, name: 'x', revision: 1, problem: NOT_SHOWN_SENTENCE },
      first,
    );
    should(result).match({ kind: 'failed', problem: { kind: 'gone', sentence: NOT_SHOWN_SENTENCE } });
  });

  it('should reuse one client across calls to the same publisher', async () => {
    const { opened, controller, subscription } = await browsed(() => undefined);
    await controller.browse(subscription);
    should(opened).have.length(1);
  });
});

describe('leave, forget, rename, list, closeAll', () => {
  it('should forget the key only after the leave was answered', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, keys } = rig({ 'DELETE /v1/shared/me/keys/self': () => ({ keyId: sub.keyId }) });
    keys.subscriptions.set(sub.daemonId, sub);
    should((await controller.leave(sub)).kind).equal('ok');
    should(keys.forgotten).deepEqual([publisher.daemonId]);
  });

  it('should not forget when the leave failed', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, keys } = rig({
      'DELETE /v1/shared/me/keys/self': () => {
        throw new MemberUnreachableError(1);
      },
    });
    keys.subscriptions.set(sub.daemonId, sub);
    should((await controller.leave(sub)).kind).equal('failed');
    should(keys.forgotten).be.empty();
  });

  it('should rename, list and forget on the person’s own tap, and close every open client', async () => {
    const sub = await testSubscription(publisher.daemonId);
    const { controller, keys, clients } = rig({
      'GET /v1/shared/me': () => {
        throw new MemberUnreachableError(1);
      },
    });
    keys.subscriptions.set(sub.daemonId, sub);
    await controller.browse(sub);
    should(await controller.rename(sub.daemonId, 'Work')).be.true();
    should((await controller.list())[0]?.ownLabel).equal('Work');
    controller.closeAll();
    await Promise.resolve();
    should(clients[0]?.closed).equal(1);
    await controller.forget(sub.daemonId);
    should(keys.forgotten).deepEqual([publisher.daemonId]);
    should(await controller.list()).be.empty();
  });
});
