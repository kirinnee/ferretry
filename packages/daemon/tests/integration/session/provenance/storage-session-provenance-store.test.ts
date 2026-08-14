import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSessionProvenanceStore,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import { createSessionPaths } from '../../../../src/lib/paths.ts';
import { parseSessionId } from '../../../../src/lib/index.ts';

/**
 * The spawn stamp's durable round trip, over a real state home.
 *
 * It lives in the INTEGRATION tier because it is an adapter: the unit and integration coverage
 * ledgers are disjoint scopes, so an adapter proved only by a unit test scores zero in both.
 *
 * The read goes through `SessionConfigSchema`, which is now the one home of the shape. That is the
 * property worth proving on a real document rather than a fake: a damaged stamp fails the WHOLE
 * config parse, so it reaches the recorder as "no stamp" and a fresh resolution runs — rather than
 * being stripped and silently read as "not a warden descendant".
 */

const NOW = '2026-08-06T10:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function openTemporaryStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-spawn-provenance-'));
  directories.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

/** Everything `SessionConfigSchema` demands, so the read half parses a whole document. */
function sessionConfig(id: string): Record<string, unknown> {
  return {
    id,
    incarnation: `${id}-1`,
    runtimeGeneration: 1,
    name: 'zelda',
    boardAccess: 'none',
    agent: 'claude-auto-atomi',
    harness: 'claude',
    modelHint: '',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/repo',
    createdAt: NOW,
    updatedAt: NOW,
    turn: 0,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  };
}

const shielded: SessionProvenance = {
  v: 1,
  at: NOW,
  origin: 'warden',
  parent: 'warden-7',
  warden: 'warden-7',
  wardenLineage: true,
  lineageSource: 'parent_stamp',
};

describe('spawn provenance storage', () => {
  it('should write a stamp into the configuration and read it back', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-stamped');
    await storage.writeConfig(id, sessionConfig(id));
    const store = new StorageSessionProvenanceStore(storage);

    // Act
    await store.write(id, { provenance: shielded });

    // Assert
    should((await store.read(id)).provenance).eql(shielded);
    await storage.close();
  });

  it('should preserve every field it does not own', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-merged');
    await storage.writeConfig(id, { ...sessionConfig(id), label: 'team', turn: 4 });

    // Act
    await new StorageSessionProvenanceStore(storage).write(id, { provenance: shielded, label: 'fleet-warden' });

    // Assert: a stamp written during a revive must not drop what another writer put there.
    const document = (await storage.readConfig(id)) as { label: string; turn: number; agent: string };
    should(document).have.property('turn', 4);
    should(document).have.property('agent', 'claude-auto-atomi');
    // The label IS owned by this writer, because it is the other half of one spawn decision.
    should(document).have.property('label', 'fleet-warden');
    await storage.close();
  });

  /**
   * A withdrawn label is an ABSENT FIELD, never `null` or `''`.
   *
   * `SessionConfigSchema` declares `label` optional and refuses a null, so a session whose forced
   * label is withdrawn has to lose the key rather than gain an empty one — a document that fails its
   * own schema is a session every surface drops.
   */
  it('should remove the label when the decision no longer carries one', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-unlabelled');
    await storage.writeConfig(id, { ...sessionConfig(id), label: 'team' });

    // Act
    await new StorageSessionProvenanceStore(storage).write(id, { provenance: shielded });

    // Assert
    const document = (await storage.readConfig(id)) as Record<string, unknown>;
    should(Object.hasOwn(document, 'label')).equal(false);
    should((await new StorageSessionProvenanceStore(storage).read(id)).label).be.undefined();
    await storage.close();
  });

  it('should answer undefined for a session that carries no stamp', async () => {
    // Arrange: "nobody has decided" and "not a descendant" are different answers.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-unstamped');
    await storage.writeConfig(id, sessionConfig(id));

    // Act + Assert
    should((await new StorageSessionProvenanceStore(storage).read(id)).provenance).be.undefined();
    await storage.close();
  });

  it('should answer undefined for a session whose stamp is present and damaged', async () => {
    // Arrange: descent claimed with no evidence — the half-true state both refinements forbid.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-damaged');
    await storage.writeConfig(id, {
      ...sessionConfig(id),
      provenance: { v: 1, at: NOW, origin: 'warden', wardenLineage: true, lineageSource: 'none' },
    });

    // Act + Assert: the whole config fails to parse, so the recorder resolves afresh rather than
    // reading a damaged record as "no warden".
    should((await new StorageSessionProvenanceStore(storage).read(id)).provenance).be.undefined();
    await storage.close();
  });

  it('should answer undefined for a session whose configuration document is not readable at all', async () => {
    // Arrange: not a damaged STAMP but a damaged DOCUMENT — the read itself throws rather than
    // answering something a schema could reject.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-torn');
    await storage.writeConfig(id, sessionConfig(id));
    await writeFile(createSessionPaths(storage.paths, id).config, '{"id": "20260806-torn"', 'utf8');

    // Act + Assert: a torn document is no stamp, so a fresh resolution runs. Raising here would fail
    // a revive over a record the next relaunch would rewrite anyway.
    should((await new StorageSessionProvenanceStore(storage).read(id)).provenance).be.undefined();
    await storage.close();
  });

  it('should answer undefined for a session that does not exist', async () => {
    // Arrange
    const storage = await openTemporaryStorage();

    // Act + Assert
    should((await new StorageSessionProvenanceStore(storage).read('20260806-absent')).provenance).be.undefined();
    await storage.close();
  });

  it('should refuse to read or write against an id the state home would not accept', async () => {
    // Arrange: a path separator in a session id must never become a directory traversal.
    const storage = await openTemporaryStorage();
    const store = new StorageSessionProvenanceStore(storage);

    // Act
    const read = await store.read('../escape');
    await store.write('../escape', { provenance: shielded });

    // Assert
    should(read.provenance).be.undefined();
    should(storage.listSessions()).be.empty();
    await storage.close();
  });
});
