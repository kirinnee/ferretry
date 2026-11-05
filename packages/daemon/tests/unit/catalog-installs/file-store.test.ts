import { beforeAll, describe, it } from 'bun:test';
import { join } from 'node:path';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import {
  CATALOG_INSTALLS_DOCUMENT,
  CATALOG_INSTALLS_V1_BACKUP,
  FileCatalogInstallStore,
} from '../../../src/adapters/catalog-installs/file-store.ts';
import type { FileSystemPort } from '../../../src/lib/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import {
  CATALOG_INSTALLS_DUPLICATE_INSTALL,
  CATALOG_INSTALLS_UNPINNED_LINK,
  CatalogInstallStateError,
  type CatalogInstallState,
  EMPTY_CATALOG_INSTALL_STATE,
  linkSequenceKey,
} from '../../../src/lib/catalog-installs/store.ts';
import { CatalogInstallRefusalError } from '../../../src/lib/catalog-installs/ports.ts';
import { LINK_ID, linkPreviewRequest, newIdentity } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, rig, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

/**
 * The file of installs as a REOPENED daemon reads it, over an in-memory filesystem: a version 2 document that
 * contradicts itself fails closed with a clear error and is never reset, and a version 1 file is upgraded whole.
 */

const files = new Map<string, string>();
const port = {
  readText: async (path: string) => files.get(path),
  writeTextAtomic: async (path: string, text: string) => {
    files.set(path, text);
  },
} as unknown as FileSystemPort;

const paths = createFoundationPaths(resolveStateHome({ fyHome: '/fy-home', homeDirectory: '/home/u' }));
const DOCUMENT = join(paths.state, CATALOG_INSTALLS_DOCUMENT);
const BACKUP = join(paths.state, CATALOG_INSTALLS_V1_BACKUP);
const open = () => new FileCatalogInstallStore(paths, port);

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const failure = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

async function installLink(r: Rig, options: Parameters<typeof linkPreviewRequest>[2] = {}, target = projectTarget()) {
  const preview = await r.service.preview(target.scope, await linkPreviewRequest(alice, target, options));
  return r.service.apply(target.scope, { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
}

const reopenWith = async (state: CatalogInstallState, tamper: (document: Record<string, unknown>) => void) => {
  files.clear();
  await open().write(state);
  const document = JSON.parse(files.get(DOCUMENT) ?? '') as Record<string, unknown>;
  tamper(document);
  files.set(DOCUMENT, JSON.stringify(document));
  return open();
};

describe('a reopened file of installs that contradicts itself', () => {
  it('should refuse a link record whose sequence pin was emptied, and a replay of an older bundle with it', async () => {
    // Arrange: sequence 3 installed, then the pins are wiped from the file on disk
    const r = rig();
    await installLink(r, { sequence: 3 });
    const damaged = await reopenWith(r.store.state, document => {
      document.linkSequences = {};
    });
    r.store.read = () => damaged.read();

    // Act: a valid, older, sequence-2 bundle of the same item version
    const replay = await failure(
      r.service.preview('project', await linkPreviewRequest(alice, projectTarget(), { sequence: 2 })),
    );

    // Assert: it fails closed with a clear error, nothing is applied, and the file is not reset
    should(replay).be.instanceOf(CatalogInstallStateError);
    should(replay).not.be.instanceOf(CatalogInstallRefusalError);
    should((replay as Error).message).containEql(CATALOG_INSTALLS_UNPINNED_LINK);
    should((replay as Error).message).containEql('no install was changed');
    should(JSON.parse(files.get(DOCUMENT) ?? '').installs).have.length(1);
  });

  it('should refuse a pin below the sequence of a record it keeps', async () => {
    const r = rig();
    await installLink(r, { sequence: 3 });
    const damaged = await reopenWith(r.store.state, document => {
      document.linkSequences = { [linkSequenceKey(alice.daemonId, LINK_ID)]: 2 };
    });

    const error = await failure(damaged.read());

    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).containEql(CATALOG_INSTALLS_UNPINNED_LINK);
  });

  it('should read the same file when it is consistent, so the refusal is about the contradiction', async () => {
    const r = rig();
    await installLink(r, { sequence: 3 });
    const intact = await reopenWith(r.store.state, () => undefined);

    should(await intact.read()).deepEqual(r.store.state);
  });

  it('should refuse two records with one install id at different places, and name nothing from the file', async () => {
    const r = rig();
    await installLink(r, { sequence: 1 });
    await installLink(r, { sequence: 1 }, runtimeTarget());
    const damaged = await reopenWith(r.store.state, document => {
      const installs = document.installs as { installId: string }[];
      installs[1]!.installId = installs[0]!.installId;
    });

    const error = await failure(damaged.read());

    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).equal(
      `${CATALOG_INSTALLS_DOCUMENT} contradicts itself (${CATALOG_INSTALLS_DUPLICATE_INSTALL}), so no install was changed`,
    );
    should((error as Error).message).not.containEql(r.store.state.installs[0]?.installId);
  });

  it('should refuse two records at one place, so an update can never lose the other record', async () => {
    const r = rig();
    await installLink(r, { sequence: 1 });
    await installLink(r, { sequence: 1 }, runtimeTarget());
    const damaged = await reopenWith(r.store.state, document => {
      const installs = document.installs as { key: string }[];
      installs[1]!.key = installs[0]!.key;
    });

    should(await failure(damaged.read())).be.instanceOf(CatalogInstallStateError);
  });

  it('should keep the generic words for a file that is simply not a record of installs', async () => {
    const r = rig();
    await installLink(r, { sequence: 1 });
    const damaged = await reopenWith(r.store.state, document => {
      document.extra = 1;
    });

    const error = await failure(damaged.read());

    should((error as Error).message).equal(
      `${CATALOG_INSTALLS_DOCUMENT} is not a record of installs this daemon writes, so no install was changed`,
    );
  });
});

const SHA = 'a'.repeat(64);
const CATALOG = `cat_${'c'.repeat(22)}`;
const catalogInstall = {
  installId: `cin_${'i'.repeat(22)}`,
  installedAt: '2026-10-31T09:00:00.000Z',
  provenance: {
    publisher: `fy_daemon_${'B'.repeat(43)}`,
    publisherName: 'kirin-box',
    catalogId: CATALOG,
    catalogName: "Kirin's catalog",
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'other-tools',
    version: 1,
    digest: `sha256:${SHA}`,
  },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
  destination: '/srv/app/.claude/skills/other-tools',
  key: 'project:/srv/app:claude:skill:other-tools',
  files: [{ path: 'SKILL.md', sha256: SHA }],
  secretBindings: {},
};

describe('the version 1 file, upgraded by the first link install', () => {
  it('should upgrade a version 1 file without losing a record, a pin or a revision', async () => {
    // Arrange: a catalog install on version 1, which has no link pins and is not refused for lacking them
    const r = rig();
    const old = `${JSON.stringify({
      schemaVersion: 1,
      installs: [catalogInstall],
      publishers: { [catalogInstall.provenance.publisher]: '2026-10-31T09:00:00.000Z' },
      pins: { [CATALOG]: catalogInstall.provenance.publisher },
      revisions: { [CATALOG]: 4 },
    })}\n`;
    files.clear();
    files.set(DOCUMENT, old);
    const store = open();
    r.store.read = () => store.read();
    r.store.write = state => store.write(state);

    // Act
    const before = await store.read();
    const linked = await installLink(r, { sequence: 2 }, runtimeTarget());
    const upgraded = await open().read();

    // Assert
    should(before.schemaVersion).equal(1);
    should(upgraded.schemaVersion).equal(2);
    should(upgraded.installs.map(install => install.installId)).deepEqual([
      catalogInstall.installId,
      linked.install.installId,
    ]);
    should(upgraded.pins).deepEqual({ [CATALOG]: catalogInstall.provenance.publisher });
    should(upgraded.revisions).deepEqual({ [CATALOG]: 4 });
    should(upgraded.linkSequences?.[linkSequenceKey(alice.daemonId, LINK_ID)]).equal(2);
    should(files.get(BACKUP)).equal(old);
  });
});

describe('the file of installs, when what is on disk is not JSON', () => {
  it('should refuse to read it, without echoing any of it', async () => {
    files.clear();
    files.set(DOCUMENT, '{ secret-looking-garbage');

    const error = await failure(open().read());

    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).equal(`${CATALOG_INSTALLS_DOCUMENT} is not JSON, so no install was changed`);
  });

  it('should keep no version 1 backup of a previous file that is not JSON when a version 2 state is written', async () => {
    files.clear();
    files.set(DOCUMENT, 'not json at all');

    await open().write({ ...EMPTY_CATALOG_INSTALL_STATE, schemaVersion: 2, linkSequences: {} });

    should(files.has(BACKUP)).be.false();
    should(JSON.parse(files.get(DOCUMENT) ?? '').schemaVersion).equal(2);
  });
});
