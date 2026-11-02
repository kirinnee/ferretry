/**
 * Fakes for a catalog MEMBER's screens: a members port that records each call and answers from a script,
 * and one verified shared item built the way a publisher would sign it.
 *
 * The code in every link here is the fixed fake one. It is not a credential of anything.
 */

import {
  parseShareFragment,
  SharedCatalogItemSchema,
  type CatalogInstall,
  type SharedCatalogItem,
  type SharedCatalogManifestEntry,
  type ShareLinkSeed,
  type SignedCatalogItemVersions,
} from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { InstalledItem } from '../../src/features/shared/shared-installs.ts';
import { type OpenedCatalogFile, openCatalogFile } from '../../src/features/catalogs/catalog-install-model.ts';
import type {
  Attempt,
  SharedBrowse,
  SharedCatalogView,
  SharedController,
} from '../../src/features/shared/shared-controller.ts';
import type { Problem, ProblemKind } from '../../src/features/shared/shared-model.ts';
import { installPreview, installRecord } from './catalog-views.ts';
import { FAKE_LINK } from './catalog-sharing.ts';
import { crypto, mcpItem, newIdentity, signedFile, signedVersionsOf, skillItem } from './catalog-files.ts';

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
  'versions',
  'openVersion',
  'leave',
  'forget',
  'rename',
  'tryAgain',
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

export interface UpdateFixture extends SharedItemFixture {
  /** The skill at version 1 (installed) and version 2 (what the manifest lists); the signed list offers both. */
  readonly v1: SharedCatalogItem;
  readonly v2: SharedCatalogItem;
  readonly signedVersions: SignedCatalogItemVersions;
  readonly entry: SharedCatalogManifestEntry;
}

/** One signed catalog listing a skill at version 2, with the publisher's signed list offering versions 1 and 2. */
export async function updateFixture(): Promise<UpdateFixture> {
  const identity = await newIdentity();
  const v1 = skillItem(identity.daemonId);
  const v2 = SharedCatalogItemSchema.parse({
    ...v1,
    itemVersion: 2,
    skill: { files: [{ path: 'SKILL.md', content: '# pdf tools, now faster\n' }] },
  });
  const file = await signedFile(identity, [v2]);
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
  const entry = manifest.items[0];
  if (entry === undefined) throw new Error('no entry');
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
    skill: v2,
    mcp: v2,
    v1,
    v2,
    opened: result.opened,
    view,
    entries: manifest.items,
    entry,
    browse: { me, catalogs: [view] },
    signedVersions: await signedVersionsOf(identity, manifest, [v1, v2], 2),
  };
}

const digestOf = (fixture: UpdateFixture, version: number): string => {
  const offered = fixture.signedVersions.versions.offered.find(line => line.version === version);
  if (offered === undefined) throw new Error(`version ${String(version)} is not offered`);
  return offered.digest;
};

/** What a machine holds after installing version 1 of the fixture's skill from its publisher. */
export function installedAtV1(fixture: UpdateFixture, change: Record<string, unknown> = {}): InstalledItem {
  const base = installRecord('skill', fixture.v1.name);
  const install: CatalogInstall = {
    ...base,
    provenance: {
      ...base.provenance,
      publisher: fixture.identity.daemonId,
      publisherName: fixture.opened.manifest.publisherName,
      catalogId: fixture.opened.manifest.catalogId,
      catalogName: fixture.opened.manifest.name,
      itemId: fixture.entry.itemId,
      version: 1,
      digest: digestOf(fixture, 1),
    },
    ...change,
  } as CatalogInstall;
  return {
    name: install.provenance.name,
    version: install.provenance.version,
    install,
    machine: {
      connection: daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' }),
      name: 'Studio laptop',
    },
  };
}

/** What that machine answers when asked to replace the installed skill with `version` of the fixture's skill. */
export function machinePreview(fixture: UpdateFixture, version: number, change: Record<string, unknown> = {}) {
  const installed = installedAtV1(fixture);
  const base = installPreview();
  const { manifest } = fixture.opened;
  return installPreview({
    provenance: {
      ...installed.install.provenance,
      version,
      digest: digestOf(fixture, version),
    },
    publisher: { ...base.publisher, daemonId: manifest.publisher, name: manifest.publisherName },
    target: installed.install.target,
    replaces: { installId: installed.install.installId, version: 1 },
    secrets: [],
    ...change,
  });
}
