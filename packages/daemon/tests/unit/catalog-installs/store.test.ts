import { describe, it } from 'bun:test';
import should from 'should';
import {
  CATALOG_INSTALLS_SCHEMA_VERSION,
  CatalogInstalledFileSchema,
  CatalogInstallRecordSchema,
  CatalogInstallStateError,
  CatalogInstallStateSchema,
  CatalogInstallStateV1Schema,
  CatalogInstallStateV2Schema,
  CATALOG_INSTALLS_DUPLICATE_INSTALL,
  CATALOG_INSTALLS_MISPLACED,
  CATALOG_INSTALLS_UNPINNED_LINK,
  EMPTY_CATALOG_INSTALL_STATE,
  installPlaceOf,
  linkSequenceKey,
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
  key: 'project:/srv/app/.claude/skills/pdf-tools',
  root: '/srv/app',
  folder: '.claude/skills/pdf-tools',
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
      CatalogInstallStateSchema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, schemaVersion: 3 }).success,
    ).be.false();
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

  it('refuses a document that is not a V1 and is not a V2: one cannot pass for the other', () => {
    const v2 = { ...EMPTY_CATALOG_INSTALL_STATE, schemaVersion: 2, linkSequences: {} };
    should(CatalogInstallStateV2Schema.safeParse(v2).success).be.true();
    should(CatalogInstallStateV1Schema.safeParse(v2).success).be.false();
    should(CatalogInstallStateV2Schema.safeParse(EMPTY_CATALOG_INSTALL_STATE).success).be.false();
    should(CatalogInstallStateSchema.parse(v2)).deepEqual(v2);
  });

  it('reads a link install in a V2 file but never in a V1 one', () => {
    const link = {
      ...record,
      provenance: {
        publisher: DAEMON,
        publisherName: 'kirin-box',
        link: { linkId: `lnk_${'a'.repeat(22)}`, kind: 'public', sequence: 2 },
        itemId: record.provenance.itemId,
        kind: 'skill',
        name: 'pdf-tools',
        version: 1,
        digest: `sha256:${SHA}`,
      },
    };
    const base = { ...EMPTY_CATALOG_INSTALL_STATE, installs: [link] };
    const pinned = { [linkSequenceKey(DAEMON, link.provenance.link.linkId)]: 2 };
    should(
      CatalogInstallStateV2Schema.safeParse({ ...base, schemaVersion: 2, linkSequences: pinned }).success,
    ).be.true();
    should(CatalogInstallStateV1Schema.safeParse(base).success).be.false();
  });

  describe('a version 2 document that contradicts itself', () => {
    /** A link install of the skill `place`, filed where it was written: the key IS its place. */
    const linkRecord = (installId: string, place: string, sequence: number, linkId = `lnk_${'a'.repeat(22)}`) => ({
      ...record,
      installId,
      key: `project:/srv/app/.claude/skills/${place}`,
      folder: `.claude/skills/${place}`,
      provenance: {
        publisher: DAEMON,
        publisherName: 'kirin-box',
        link: { linkId, kind: 'public', sequence },
        itemId: record.provenance.itemId,
        kind: 'skill',
        name: 'pdf-tools',
        version: 1,
        digest: `sha256:${SHA}`,
      },
    });
    const idOf = (letter: string) => `cin_${letter.repeat(22)}`;
    const pinKey = linkSequenceKey(DAEMON, `lnk_${'a'.repeat(22)}`);
    const v2 = (installs: unknown[], linkSequences: Record<string, number>) => ({
      ...EMPTY_CATALOG_INSTALL_STATE,
      schemaVersion: 2,
      installs,
      linkSequences,
    });
    const reasons = (document: unknown): string[] => {
      const parsed = CatalogInstallStateSchema.safeParse(document);
      return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
    };

    it('refuses a link install whose sequence pin is missing', () => {
      const document = v2([linkRecord(idOf('a'), 'k1', 3)], {});
      should(CatalogInstallStateV2Schema.safeParse(document).success).be.false();
      should(reasons(document)).containEql(CATALOG_INSTALLS_UNPINNED_LINK);
    });

    it('refuses a link install whose sequence pin is below its own sequence, and takes one at or above it', () => {
      should(reasons(v2([linkRecord(idOf('a'), 'k1', 3)], { [pinKey]: 2 }))).containEql(CATALOG_INSTALLS_UNPINNED_LINK);
      should(reasons(v2([linkRecord(idOf('a'), 'k1', 3)], { [pinKey]: 3 }))).deepEqual([]);
      should(reasons(v2([linkRecord(idOf('a'), 'k1', 3)], { [pinKey]: 7 }))).deepEqual([]);
    });

    it('checks every retained link record, not only the first', () => {
      const installs = [linkRecord(idOf('a'), 'k1', 1), linkRecord(idOf('b'), 'k2', 5)];
      should(reasons(v2(installs, { [pinKey]: 4 }))).containEql(CATALOG_INSTALLS_UNPINNED_LINK);
      should(reasons(v2(installs, { [pinKey]: 5 }))).deepEqual([]);
    });

    it('does not ask a pin of a catalog install, and lets a pin outlive its installs', () => {
      should(reasons(v2([record], {}))).deepEqual([]);
      should(reasons(v2([], { [pinKey]: 9 }))).deepEqual([]);
    });

    it('refuses two installs with one install id at different places', () => {
      const document = v2([linkRecord(idOf('a'), 'k1', 1), linkRecord(idOf('a'), 'k2', 1)], { [pinKey]: 1 });
      should(reasons(document)).deepEqual([CATALOG_INSTALLS_DUPLICATE_INSTALL]);
    });

    it('refuses two installs at one place under different ids', () => {
      const document = v2([linkRecord(idOf('a'), 'k1', 1), linkRecord(idOf('b'), 'k1', 1)], { [pinKey]: 1 });
      should(reasons(document)).deepEqual([CATALOG_INSTALLS_DUPLICATE_INSTALL]);
    });

    it('takes distinct ids at distinct places', () => {
      const document = v2([linkRecord(idOf('a'), 'k1', 1), linkRecord(idOf('b'), 'k2', 1)], { [pinKey]: 1 });
      should(reasons(document)).deepEqual([]);
    });

    it('says both things when both are wrong', () => {
      const document = v2([linkRecord(idOf('a'), 'k1', 4), linkRecord(idOf('a'), 'k1', 4)], {});
      should(reasons(document)).deepEqual([CATALOG_INSTALLS_DUPLICATE_INSTALL, CATALOG_INSTALLS_UNPINNED_LINK]);
    });

    describe('an install filed under a place other than the one it wrote to', () => {
      const projectSkill = linkRecord(idOf('a'), 'pdf-tools', 1);
      const refused = (install: unknown) => reasons(v2([install], { [pinKey]: 1 }));

      it('takes a record whose key is the place its root and folder say', () => {
        should(refused(projectSkill)).deepEqual([]);
      });

      it('refuses a clone of one project install under a fresh id with only its key respelled (/./)', () => {
        const clone = { ...projectSkill, installId: idOf('b'), key: 'project:/srv/app/./.claude/skills/pdf-tools' };
        should(reasons(v2([projectSkill, clone], { [pinKey]: 1 }))).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        should(refused(clone)).deepEqual([CATALOG_INSTALLS_MISPLACED]);
      });

      it('refuses the same physical place filed twice even when only the root and folder are respelled', () => {
        const clone = {
          ...projectSkill,
          installId: idOf('b'),
          root: '/srv/./app/',
          folder: '.claude/./skills/pdf-tools',
        };
        // The respelled folder is not canonical, so the clone is refused for that as well as for being the same place.
        should(reasons(v2([projectSkill, clone], { [pinKey]: 1 }))).deepEqual([
          CATALOG_INSTALLS_DUPLICATE_INSTALL,
          CATALOG_INSTALLS_MISPLACED,
        ]);
      });

      it('refuses a parent-relative alias of a place already there, filed under a key and prefixes that match it', () => {
        const alias = {
          ...projectSkill,
          installId: idOf('b'),
          key: 'project:/srv/app/../app/.claude/skills/pdf-tools',
          folder: '../app/.claude/skills/pdf-tools',
        };
        should(refused(alias)).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        should(reasons(v2([projectSkill, alias], { [pinKey]: 1 }))).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        const normalised = { ...alias, key: projectSkill.key };
        should(reasons(v2([projectSkill, normalised], { [pinKey]: 1 }))).deepEqual([
          CATALOG_INSTALLS_DUPLICATE_INSTALL,
          CATALOG_INSTALLS_MISPLACED,
        ]);
      });

      it('refuses a folder that is absolute, leaves its root, is the root itself, or is not canonical', () => {
        for (const folder of ['/etc/skills/x', '..', '../x', '../../x', '.', 'a/../b', './a', 'a//b', 'a/'])
          should(refused({ ...projectSkill, folder, key: `project:/srv/app/${folder}` })).deepEqual([
            CATALOG_INSTALLS_MISPLACED,
          ]);
      });

      it('refuses a project server whose record also names a folder (the clone that removal would take for a server)', () => {
        const server = {
          ...projectSkill,
          installId: idOf('b'),
          provenance: { ...projectSkill.provenance, kind: 'mcp', name: 'docs' },
          key: 'project:/srv/app/.mcp.json#docs',
          files: [{ path: '.mcp.json', sha256: SHA, entry: 'docs' }],
        };
        // folder is still .claude/skills/pdf-tools: a fake skill folder beside a real server entry.
        should(refused(server)).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        should(refused({ ...server, key: projectSkill.key })).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        const original = { ...server, installId: idOf('a') };
        const { folder: _folder, ...plainServer } = original;
        should(reasons(v2([plainServer, server], { [pinKey]: 1 }))).deepEqual([
          CATALOG_INSTALLS_DUPLICATE_INSTALL,
          CATALOG_INSTALLS_MISPLACED,
        ]);
      });

      it('refuses a runtime record that also names a root or a folder', () => {
        const {
          root: _root,
          folder: _folder,
          ...bare
        } = {
          ...projectSkill,
          target: { scope: 'runtime', runtime: 'claude-main', profile: 'main' },
          key: 'fleet:skills/pdf-tools',
        };
        should(refused(bare)).deepEqual([]);
        should(refused({ ...bare, root: '/srv/app' })).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        should(refused({ ...bare, folder: '.claude/skills/pdf-tools' })).deepEqual([CATALOG_INSTALLS_MISPLACED]);
      });

      it('refuses a key that names some other place, and a project install that does not say where it is', () => {
        should(refused({ ...projectSkill, key: 'project:/srv/other/.claude/skills/pdf-tools' })).deepEqual([
          CATALOG_INSTALLS_MISPLACED,
        ]);
        const { root: _root, ...noRoot } = projectSkill;
        const { folder: _folder, ...noFolder } = projectSkill;
        should(refused(noRoot)).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        should(refused(noFolder)).deepEqual([CATALOG_INSTALLS_MISPLACED]);
      });

      it('knows a project server by its entry in the root’s .mcp.json', () => {
        const { folder: _folder, ...base } = projectSkill;
        const server = {
          ...base,
          provenance: { ...projectSkill.provenance, kind: 'mcp', name: 'docs' },
          key: 'project:/srv/app/.mcp.json#docs',
          files: [{ path: '.mcp.json', sha256: SHA, entry: 'docs' }],
        };
        should(refused(server)).deepEqual([]);
        should(refused({ ...server, key: 'project:/srv/app/./.mcp.json#docs' })).deepEqual([
          CATALOG_INSTALLS_MISPLACED,
        ]);
        should(refused({ ...server, files: [{ path: '.mcp.json', sha256: SHA, entry: 'other' }] })).deepEqual([
          CATALOG_INSTALLS_MISPLACED,
        ]);
      });

      it('knows a runtime item by its kind and name, wherever the key is spelled', () => {
        const runtime = {
          ...projectSkill,
          target: { scope: 'runtime', runtime: 'claude-main', profile: 'main' },
          key: 'fleet:skills/pdf-tools',
        };
        const { root: _root, folder: _folder, ...bare } = runtime;
        should(refused(bare)).deepEqual([]);
        should(refused({ ...bare, key: 'fleet:skills/pdf-tools/' })).deepEqual([CATALOG_INSTALLS_MISPLACED]);
        const server = {
          ...bare,
          provenance: { ...projectSkill.provenance, kind: 'mcp', name: 'docs' },
          key: 'fleet:mcp/docs',
        };
        should(refused(server)).deepEqual([]);
        should(refused({ ...server, key: 'fleet:skills/docs' })).deepEqual([CATALOG_INSTALLS_MISPLACED]);
      });
    });

    describe('every destination kind a daemon writes still loads, in both versions', () => {
      const kinds = {
        'a project skill': { ...record, key: 'project:/srv/app/.claude/skills/pdf-tools' },
        'a project server': {
          ...record,
          folder: undefined,
          key: 'project:/srv/app/.mcp.json#docs',
          provenance: { ...record.provenance, kind: 'mcp', name: 'docs' },
          files: [{ path: '.mcp.json', sha256: SHA, entry: 'docs' }],
        },
        'a runtime skill': {
          ...record,
          root: undefined,
          folder: undefined,
          target: { scope: 'runtime', runtime: 'claude-main', profile: 'main' },
          key: 'fleet:skills/pdf-tools',
        },
        'a runtime server': {
          ...record,
          root: undefined,
          folder: undefined,
          target: { scope: 'runtime', runtime: 'claude-main', profile: 'main' },
          key: 'fleet:mcp/docs',
          provenance: { ...record.provenance, kind: 'mcp', name: 'docs' },
        },
      };
      for (const [name, install] of Object.entries(kinds))
        it(`reads ${name}`, () => {
          const clean = JSON.parse(JSON.stringify(install)) as Record<string, unknown>;
          should(
            CatalogInstallStateV1Schema.safeParse({ ...EMPTY_CATALOG_INSTALL_STATE, installs: [clean] }).success,
          ).be.true();
          should(reasons(v2([clean], {}))).deepEqual([]);
        });
    });

    it('knows where an install is, once, for the reader and for removal', () => {
      const parsed = (install: unknown) => CatalogInstallRecordSchema.parse(JSON.parse(JSON.stringify(install)));
      should(installPlaceOf(parsed(record))).deepEqual({
        kind: 'folder',
        key: 'project:/srv/app/.claude/skills/pdf-tools',
        root: '/srv/app',
        folder: '.claude/skills/pdf-tools',
      });
      const { folder: _folder, ...noFolder } = record;
      should(
        installPlaceOf(
          parsed({ ...noFolder, root: '/srv/./app/', files: [{ path: '.mcp.json', sha256: SHA, entry: 'docs' }] }),
        ),
      ).deepEqual({ kind: 'server', key: 'project:/srv/app/.mcp.json#docs', root: '/srv/app', entry: 'docs' });
      should(
        installPlaceOf(parsed({ ...record, files: [{ path: '.mcp.json', sha256: SHA, entry: 'docs' }] })),
      ).be.undefined();
      should(installPlaceOf(parsed(noFolder))).be.undefined();
      const { root: _root, ...noRoot } = record;
      should(installPlaceOf(parsed(noRoot))).be.undefined();
      const runtime = { ...noFolder, root: undefined, target: { scope: 'runtime', runtime: 'r', profile: 'p' } };
      should(installPlaceOf(parsed(runtime))).deepEqual({ kind: 'runtime', key: 'fleet:skills/pdf-tools' });
      should(installPlaceOf(parsed({ ...runtime, root: '/srv/app' }))).be.undefined();
    });

    it('does not hold a version 1 file to either rule: it has no pins and is upgraded, not refused', () => {
      const v1 = {
        ...EMPTY_CATALOG_INSTALL_STATE,
        installs: [record, { ...record, key: 'other' }, { ...record, installId: idOf('z') }],
      };
      should(CatalogInstallStateV1Schema.safeParse(v1).success).be.true();
      should(CatalogInstallStateSchema.safeParse(v1).success).be.true();
    });
  });

  it('refuses a link sequence below one, above the signed maximum, or under an empty key', () => {
    const v2 = { ...EMPTY_CATALOG_INSTALL_STATE, schemaVersion: 2 };
    for (const linkSequences of [{ a: 0 }, { a: 0x1_0000_0000 }, { '': 1 }])
      should(CatalogInstallStateV2Schema.safeParse({ ...v2, linkSequences }).success).be.false();
  });

  it('keys a link by its publisher and its id, so two publishers never share a pin', () => {
    should(linkSequenceKey(DAEMON, 'lnk_x')).equal(`${DAEMON}/lnk_x`);
    should(linkSequenceKey('a', 'lnk_x')).not.equal(linkSequenceKey('b', 'lnk_x'));
  });
});
