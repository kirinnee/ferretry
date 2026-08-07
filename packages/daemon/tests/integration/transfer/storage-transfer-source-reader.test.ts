import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import { StorageTransferSourceReader } from '../../../src/adapters/transfer/storage-transfer-source-reader.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

/**
 * The complete source projection, off real session documents.
 *
 * Two properties are load-bearing beyond the field list: the reader must answer `undefined` for
 * anything it cannot describe completely, and it must be incapable of touching the source at all —
 * preparation's I1 is a construction property, so the proof is which storage methods this adapter
 * can be observed reaching for, not a promise in a comment.
 */

const NOW = '2026-08-06T09:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function openTemporaryStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-transfer-source-'));
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

const transcript: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  harnessSessionId: 'harness-1',
  identity: 'correlated',
  file: '/home/agent/.claude/projects/source.jsonl',
  resolvedAt: NOW,
};

const stamp = {
  v: 1,
  at: NOW,
  origin: 'warden',
  parent: '20260806-parent',
  warden: '20260806-warden',
  wardenLineage: true,
  lineageSource: 'parent_stamp',
};

/**
 * One complete configuration document, as a live session carries it.
 *
 * An override of `undefined` REMOVES the field, which is what a session started without a model or a
 * label actually looks like on disk — the document has no such key at all.
 */
function configuration(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const document: Record<string, unknown> = {
    id,
    incarnation: 'inc-7',
    runtimeGeneration: 3,
    name: 'Port The Transfer Seam',
    teammate: 'alistair',
    label: 'f117',
    parent: '20260806-parent',
    boardAccess: 'worker',
    agent: 'claude-auto-loge',
    harness: 'claude',
    modelHint: 'opus',
    model: 'claude-opus-5',
    mode: 'auto',
    remoteControl: true,
    harnessFlags: ['--dangerously-skip-permissions'],
    cwd: '/work/repo',
    createdAt: NOW,
    updatedAt: NOW,
    turn: 12,
    intervalSeconds: 60,
    timeoutSeconds: 900,
    nudgeAfterSeconds: 300,
    killAfterSeconds: 1800,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'summary',
    maxSnapshots: 20,
    transcript,
    provenance: stamp,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    ...overrides,
  };
  for (const [field, value] of Object.entries(document)) if (value === undefined) delete document[field];
  return document;
}

/** The real storage, wrapped so every method the adapter reaches for is recorded. */
function watched(storage: DaemonStorage): { readonly storage: DaemonStorage; readonly touched: string[] } {
  const touched: string[] = [];
  const proxy = new Proxy(storage, {
    get(target, property) {
      if (typeof property === 'string' && !touched.includes(property)) touched.push(property);
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: proxy, touched };
}

describe('StorageTransferSourceReader', () => {
  it('should project every durable field a transfer plan is built from', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-source');
    await storage.writeConfig(id, configuration(id));

    // Act
    const source = await new StorageTransferSourceReader(storage).read(id);

    // Assert: the whole inventory, and nothing the new session must decide fresh.
    should(source).eql({
      sessionId: id,
      incarnation: 'inc-7',
      runtimeGeneration: 3,
      harness: 'claude',
      agent: 'claude-auto-loge',
      model: 'claude-opus-5',
      teammate: 'alistair',
      name: 'Port The Transfer Seam',
      label: 'f117',
      cwd: '/work/repo',
      mode: 'auto',
      remoteControl: true,
      harnessFlags: ['--dangerously-skip-permissions'],
      intervalSeconds: 60,
      timeoutSeconds: 900,
      nudgeAfterSeconds: 300,
      killAfterSeconds: 1800,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'summary',
      maxSnapshots: 20,
      retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
      transcriptProvenance: transcript,
      provenance: stamp,
    });
    await storage.close();
  });

  it('should read the source and be unable to do anything else to it', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-readonly');
    await storage.writeConfig(id, configuration(id, { model: undefined }));
    await storage.writeState(id, { id, status: 'running', turn: 1 });
    const observed = watched(storage);

    // Act
    await new StorageTransferSourceReader(observed.storage).read(id);

    // Assert: two reads, and a prototype with no second capability on it (I1, I2).
    should(observed.touched.sort()).eql(['readConfig', 'readState']);
    should(Object.getOwnPropertyNames(StorageTransferSourceReader.prototype).sort()).eql([
      'constructor',
      'observedModel',
      'read',
    ]);
    await storage.close();
  });

  it('should fall back to the model the harness was observed running, and treat blanks as absent', async () => {
    // Arrange: a session started from a hint carries no configured model.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-observed');
    await storage.writeConfig(id, configuration(id, { model: undefined, teammate: '', label: '   ' }));
    await storage.writeState(id, { id, status: 'running', turn: 4, observedModel: 'claude-opus-5-1m' });

    // Act
    const source = await new StorageTransferSourceReader(storage).read(id);

    // Assert
    should(source?.model).equal('claude-opus-5-1m');
    should(source?.teammate).be.null();
    should(source?.label).be.null();
    await storage.close();
  });

  it('should answer a null model rather than invent one when nothing records it', async () => {
    // Arrange: no configured model, and a state document that has never seen the harness say.
    const storage = await openTemporaryStorage();
    const withoutState = parseSessionId('20260806-nostate');
    const damagedState = parseSessionId('20260806-badstate');
    await storage.writeConfig(withoutState, configuration(withoutState, { model: undefined }));
    await storage.writeConfig(damagedState, configuration(damagedState, { model: undefined }));
    await storage.writeState(damagedState, { id: damagedState, status: 'not-a-status' });

    // Act
    const reader = new StorageTransferSourceReader(storage);
    const missing = await reader.read(withoutState);
    const damaged = await reader.read(damagedState);

    // Assert: a damaged state document costs the enrichment and nothing else.
    should(missing?.model).be.null();
    should(damaged?.model).be.null();
    should(damaged?.name).equal('Port The Transfer Seam');
    await storage.close();
  });

  it('should refuse a source whose warden stamp is present and unreadable', async () => {
    // Arrange: three stamps that are THERE and do not parse — one whose lineage disagrees with its
    // own evidence, one claiming descent it cannot attribute, and one that is not a record at all.
    const storage = await openTemporaryStorage();
    const inconsistent = parseSessionId('20260806-badstamp');
    const untraceable = parseSessionId('20260806-unnamedwarden');
    const nonsense = parseSessionId('20260806-stampnonsense');
    await storage.writeConfig(
      inconsistent,
      configuration(inconsistent, {
        provenance: { v: 1, at: NOW, origin: 'warden', wardenLineage: true, lineageSource: 'none' },
      }),
    );
    await storage.writeConfig(
      untraceable,
      configuration(untraceable, {
        provenance: { v: 1, at: NOW, origin: 'warden', wardenLineage: true, lineageSource: 'parent_stamp' },
      }),
    );
    await storage.writeConfig(nonsense, configuration(nonsense, { provenance: 'warden' }));

    // Act
    const reader = new StorageTransferSourceReader(storage);

    // Assert: a damaged shield must never reach the lineage facet, which cannot tell it apart from a
    // session that was never stamped and would write `wardenLineage: false` into the new session.
    should(await reader.read(inconsistent)).be.undefined();
    should(await reader.read(untraceable)).be.undefined();
    should(await reader.read(nonsense)).be.undefined();
    await storage.close();
  });

  it('should carry a session that was never stamped, and the exact stamp of one that was', async () => {
    // Arrange: never stamped is a different fact from stamped-and-damaged, and only this one crosses.
    const storage = await openTemporaryStorage();
    const unstamped = parseSessionId('20260806-unstamped');
    const shielded = parseSessionId('20260806-shielded');
    await storage.writeConfig(unstamped, configuration(unstamped, { provenance: undefined }));
    await storage.writeConfig(shielded, configuration(shielded));

    // Act
    const reader = new StorageTransferSourceReader(storage);
    const withoutStamp = await reader.read(unstamped);
    const withStamp = await reader.read(shielded);

    // Assert: the facet decides what "no stamp" means; the reader neither pre-empts nor weakens it.
    should(withoutStamp).not.be.undefined();
    should(withoutStamp?.provenance).be.undefined();
    should(withStamp?.provenance).eql(stamp);
    await storage.close();
  });

  it('should answer nothing for a session that cannot be described completely', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const partial = parseSessionId('20260806-partial');
    await storage.writeConfig(partial, { id: partial, harness: 'claude' });

    // Act
    const reader = new StorageTransferSourceReader(storage);
    const unusable = await reader.read('../escape');
    const absent = await reader.read('20260806-never-existed');
    const incomplete = await reader.read(partial);

    // Assert: preparation refuses instead of planning from a half-read source.
    should(unusable).be.undefined();
    should(absent).be.undefined();
    should(incomplete).be.undefined();
    await storage.close();
  });

  it('should distinguish a session with no transcript record from one whose record is damaged', async () => {
    // Arrange: a session started before its rollout was correlated simply has no record. A
    // hand-edited one is different, and must never be read as a file a byte offset can address.
    const storage = await openTemporaryStorage();
    const unresolved = parseSessionId('20260806-notranscript');
    const damaged = parseSessionId('20260806-badtranscript');
    await storage.writeConfig(unresolved, configuration(unresolved, { transcript: undefined }));
    await storage.writeConfig(damaged, configuration(damaged, { transcript: { v: 1, identity: 'correlated' } }));

    // Act
    const reader = new StorageTransferSourceReader(storage);
    const withoutTranscript = await reader.read(unresolved);
    const withDamagedTranscript = await reader.read(damaged);

    // Assert: no record is a null the plan can carry; a damaged one refuses the whole source.
    should(withoutTranscript?.transcriptProvenance).be.null();
    should(withDamagedTranscript).be.undefined();
    await storage.close();
  });
});
