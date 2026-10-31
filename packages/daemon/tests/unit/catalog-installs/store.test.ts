import { describe, it } from 'bun:test';
import should from 'should';
import {
  CATALOG_INSTALLS_SCHEMA_VERSION,
  CatalogInstalledFileSchema,
  CatalogInstallRecordSchema,
  CatalogInstallStateError,
  CatalogInstallStateSchema,
  EMPTY_CATALOG_INSTALL_STATE,
} from '../../../src/lib/catalog-installs/store.ts';

/**
 * What the machine remembers about installs: the shapes the file may hold, and what an empty one is.
 * A damaged file is refused by the parse, never answered as "no installs" (the adapter turns the throw
 * into {@link CatalogInstallStateError}).
 */

const SHA = 'a'.repeat(64);
const DAEMON = `fy_daemon_${'A'.repeat(43)}`;
const INSTALL = `cin_${'i'.repeat(22)}`;

const record = {
  installId: INSTALL,
  installedAt: '2026-10-31T09:00:00.000Z',
  provenance: {
    publisher: DAEMON,
    publisherName: 'kirin-box',
    catalogId: `cat_${'c'.repeat(22)}`,
    catalogName: "Kirin's catalog",
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'pdf-tools',
    version: 1,
    digest: `sha256:${SHA}`,
  },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
  destination: '/srv/app/.claude/skills/pdf-tools',
  key: 'project:/srv/app:claude:skill:pdf-tools',
  files: [{ path: 'SKILL.md', sha256: SHA }],
  secretBindings: {},
};

describe('the file of installs', () => {
  it('starts empty, at the current schema version', () => {
    should(EMPTY_CATALOG_INSTALL_STATE).deepEqual({
      schemaVersion: CATALOG_INSTALLS_SCHEMA_VERSION,
      installs: [],
      publishers: {},
      pins: {},
      revisions: {},
    });
    should(() => CatalogInstallStateSchema.parse(EMPTY_CATALOG_INSTALL_STATE)).not.throw();
  });

  it('reads a record with a whole-file entry and one that names a server inside a shared file', () => {
    should(CatalogInstalledFileSchema.safeParse({ path: '.mcp.json', sha256: SHA, entry: 'acme' }).success).be.true();
    should(CatalogInstallRecordSchema.safeParse(record).success).be.true();
  });

  it('reads a full state with a publisher, a pin and a revision', () => {
    const state = {
      schemaVersion: 1,
      installs: [record],
      publishers: { [DAEMON]: '2026-10-31T09:00:00.000Z' },
      pins: { [record.provenance.catalogId]: DAEMON },
      revisions: { [record.provenance.catalogId]: 3 },
    };

    should(CatalogInstallStateSchema.parse(state)).deepEqual(state);
  });

  it('refuses a hash that is not 64 lowercase hex characters', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'zz'.repeat(32)])
      should(CatalogInstalledFileSchema.safeParse({ path: 'SKILL.md', sha256 }).success).be.false();
  });

  it('refuses an empty path, an empty entry, and a field it does not know', () => {
    should(CatalogInstalledFileSchema.safeParse({ path: '', sha256: SHA }).success).be.false();
    should(CatalogInstalledFileSchema.safeParse({ path: 'x', sha256: SHA, entry: '' }).success).be.false();
    should(CatalogInstalledFileSchema.safeParse({ path: 'x', sha256: SHA, extra: 1 }).success).be.false();
    should(CatalogInstallRecordSchema.safeParse({ ...record, extra: 1 }).success).be.false();
  });

  it('refuses a record with no key, or a bad install id', () => {
    should(CatalogInstallRecordSchema.safeParse({ ...record, key: '' }).success).be.false();
    should(CatalogInstallRecordSchema.safeParse({ ...record, installId: 'cin_short' }).success).be.false();
  });

  it('refuses another schema version, a missing section, and an unknown one', () => {
    should(
      CatalogInstallStateSchema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, schemaVersion: 2 }).success,
    ).be.false();
    const { pins: _pins, ...withoutPins } = EMPTY_CATALOG_INSTALL_STATE;
    should(CatalogInstallStateSchema.safeParse(withoutPins).success).be.false();
    should(CatalogInstallStateSchema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, extra: 1 }).success).be.false();
  });

  it('refuses a pin to something that is not a daemon id, and a revision below one', () => {
    const catalogId = record.provenance.catalogId;
    should(
      CatalogInstallStateSchema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, pins: { [catalogId]: 'nobody' } }).success,
    ).be.false();
    should(
      CatalogInstallStateSchema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, revisions: { [catalogId]: 0 } }).success,
    ).be.false();
  });

  it('names its error so a caller can tell a damaged file from a bug', () => {
    const error = new CatalogInstallStateError('damaged');

    should(error).be.instanceOf(Error);
    should(error.name).equal('CatalogInstallStateError');
    should(error.message).equal('damaged');
  });
});
