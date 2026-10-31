/**
 * Fakes for a catalog MEMBER's screens: a members port that records each call and answers from a script,
 * and one verified shared item built the way a publisher would sign it.
 *
 * The code in every link here is the fixed fake one. It is not a credential of anything.
 */

import {
  parseShareFragment,
  type SharedCatalogItem,
  type SharedCatalogManifestEntry,
  type ShareLinkSeed,
} from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { type OpenedCatalogFile, openCatalogFile } from '../../src/features/catalogs/catalog-install-model.ts';
import type {
  Attempt,
  SharedBrowse,
  SharedCatalogView,
  SharedController,
} from '../../src/features/shared/shared-controller.ts';
import type { Problem, ProblemKind } from '../../src/features/shared/shared-model.ts';
import { FAKE_LINK } from './catalog-sharing.ts';
import { crypto, mcpItem, newIdentity, signedFile, skillItem } from './catalog-files.ts';

export const FAKE_FRAGMENT = `#${FAKE_LINK.split('#')[1]}`;
export const SEED: ShareLinkSeed = parseShareFragment(FAKE_FRAGMENT);

const NAMES = [
  'list',
  'begin',
  'join',
  'addPasskey',
  'unlock',
  'redeem',
  'browse',
  'openItem',
  'leave',
  'forget',
  'rename',
] as const;

export type Members = Pick<SharedController, (typeof NAMES)[number]>;

/** A members port that answers each method from `handlers` and records its name. An unlisted method fails the test. */
export function fakeMembers(handlers: { readonly [K in keyof Members]?: Members[K] }) {
  const calls: string[] = [];
  const members: Record<string, unknown> = {};
  for (const name of NAMES) {
    members[name] = async (...args: unknown[]) => {
      calls.push(name);
      const handler = handlers[name] as ((...given: unknown[]) => unknown) | undefined;
      if (handler === undefined) throw new Error(`unexpected members.${name}`);
      return await handler(...args);
    };
  }
  return { members: members as unknown as Members, calls };
}

export const okAttempt = <T>(value: T): Attempt<T> => ({ kind: 'ok', value });
export const refusedAttempt = <T>(): Attempt<T> => ({ kind: 'refused' });
export const failedAttempt = <T>(kind: ProblemKind, sentence: string): Attempt<T> => ({
  kind: 'failed',
  problem: { kind, sentence } satisfies Problem,
});

/** A promise settled by the test, to look at a screen while a call is in flight. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface SharedItemFixture {
  readonly identity: DaemonIdentity;
  readonly skill: SharedCatalogItem;
  readonly mcp: SharedCatalogItem;
  readonly opened: OpenedCatalogFile;
  readonly view: SharedCatalogView;
  readonly entries: readonly SharedCatalogManifestEntry[];
  readonly browse: SharedBrowse;
}

/** One signed catalog of two items, verified, as a publisher would serve it. */
export async function sharedItemFixture(): Promise<SharedItemFixture> {
  const identity = await newIdentity();
  const skill = skillItem(identity.daemonId);
  const mcp = mcpItem(identity.daemonId);
  const file = await signedFile(identity, [skill, mcp]);
  const result = await openCatalogFile(JSON.stringify(file), crypto);
  if (!result.ok) throw new Error(result.sentence);
  const { manifest } = result.opened;
  const view: SharedCatalogView = {
    catalogId: manifest.catalogId,
    name: manifest.name,
    revision: manifest.revision,
    signed: file.signedManifest,
    manifest,
  };
  const me = {
    memberId: `mbr_${'a'.repeat(22)}`,
    keyId: `mk_${'1'.repeat(22)}`,
    label: 'Alice',
    daemonId: identity.daemonId,
    daemonName: 'kirin-box',
    catalogs: [{ catalogId: manifest.catalogId, name: manifest.name, revision: manifest.revision }],
    carriers: [],
    unlockExpiresAt: '2026-11-30T10:00:00.000Z',
    passkeys: 1,
  } as unknown as SharedBrowse['me'];
  return {
    identity,
    skill,
    mcp,
    opened: result.opened,
    view,
    entries: manifest.items,
    browse: { me, catalogs: [view] },
  };
}
