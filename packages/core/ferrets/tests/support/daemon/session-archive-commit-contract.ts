import { expect, test } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import { ArchiveFile, FerretHistoryFiles, FerretConfigFile, FerretStateFile } from '../../../contract/index.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { KeyedSerialExecutor } from '../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { createSessionArchive } from '../../../daemon/adapters/session/archive/session-archive.ts';
import { StorageSessionLifecycleRepository } from '../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { createFoundationPaths, createSessionPaths } from '../../../daemon/lib/paths.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { RecordingLog } from './storage.ts';

const NOW = '2026-11-06T12:00:00.000Z';
const OLD = '2026-11-01T00:00:00.000Z';
const paths = createFoundationPaths('/tmp/review-only-no-io' as never);
type Doc = { config?: Record<string, unknown>; state: Record<string, unknown> };
export const ended = (parent?: string): Doc => ({
  config: { mode: 'auto', ...(parent ? { parent } : {}) },
  state: { status: 'completed', finishedAt: OLD },
});

/**
 * A state port over the fixture's documents: the session files are `docs`, the journal is always empty, and the
 * archive registry is one value whose every write first runs `beforePersist` (the registry IO a test interleaves with).
 */
function documentsPort(docs: Map<string, Doc>, beforePersist: () => void | Promise<void>): StatePort {
  let registry: unknown;
  const kindOf = (file: StateFileDef): 'config' | 'state' | undefined =>
    file === FerretConfigFile ? 'config' : file === FerretStateFile ? 'state' : undefined;
  return {
    read: async (file, name) => {
      if (file === ArchiveFile) return ok(registry as never);
      const kind = kindOf(file);
      return ok((kind === undefined || name === undefined ? undefined : docs.get(name)?.[kind]) as never);
    },
    write: async (file, value, name) => {
      if (file === ArchiveFile) {
        await beforePersist();
        registry = value;
        return;
      }
      const kind = kindOf(file);
      if (kind === undefined || name === undefined) throw new Error(`the fixture does not hold ${file.path}`);
      const doc = docs.get(name) ?? { state: {} };
      doc[kind] = value as Record<string, unknown>;
      docs.set(name, doc);
    },
    update: async () => {
      throw new Error('the fixture holds no update');
    },
    append: async () => {
      throw new Error('the fixture holds no journal');
    },
    lines: () => (async function* () {})(),
    list: async file =>
      file === FerretHistoryFiles
        ? []
        : [...docs.entries()].filter(([, doc]) => doc[kindOf(file) ?? 'state'] !== undefined).map(([id]) => id),
    remove: async (file, name) => {
      const kind = kindOf(file);
      if (kind !== undefined && name !== undefined) docs.delete(name);
    },
    sqlite: () => {
      throw new Error('the fixture injects its index');
    },
    version: async () => undefined,
    records: async () => ({ records: [], unreadable: 0 }),
    tail: async () => ({ records: [], unreadable: 0 }),
    stat: async () => undefined,
    removeEmptyDirectory: async () => {
      throw new Error('the fixture holds no folders');
    },
    createPrivateDirectory: async () => {
      throw new Error('the fixture holds no folders');
    },
    pathOf: () => {
      throw new Error('the fixture holds no paths');
    },
    damaged: () => [],
  };
}

export function fixture(
  options: {
    docs?: Map<string, Doc>;
    beforeLocks?: (docs: Map<string, Doc>) => void;
    duringBoundary?: (docs: Map<string, Doc>) => void;
    beforePersist?: (docs: Map<string, Doc>, pins: Map<string, string>) => void | Promise<void>;
    openCard?: () => boolean;
    openAgenda?: () => boolean;
  } = {},
) {
  const docs = options.docs ?? new Map([['lead-1', ended()]]);
  const rows = new Map(
    [...docs.keys()].map(id => [
      id,
      {
        id: parseSessionId(id),
        status: 'completed',
        lastSequence: 0,
        journalLine: 1,
        journal: null,
      },
    ]),
  );
  const pins = new Map<string, string>();
  const serial = new KeyedSerialExecutor();
  let keepReads = 0;
  const storage = new DaemonStorage(
    documentsPort(docs, async () => await options.beforePersist?.(docs, pins)),
    { now: () => NOW },
    new RecordingLog(),
    {
      findSession: (id: string) => rows.get(id),
      removeSession: (id: string) => rows.delete(id),
      // Publish new sessions in the index as soon as the scripted creation lands.
      listSessions: () => [...docs.keys()].filter(id => !storage.isArchived(parseSessionId(id))).map(id => ({ id })),
    } as never,
    {
      run: async (key: string, work: () => Promise<unknown>) => await serial.run(key, work),
      runAcross: async (ids: string[], work: () => Promise<unknown>) =>
        serial.runAcross(ids, async () => {
          options.beforeLocks?.(docs);
          return await work();
        }),
    } as never,
  );
  storage.readConfig = async id => {
    const config = docs.get(id)?.config;
    if (config === undefined) throw new Error('unreadable config');
    return config as never;
  };
  storage.readState = async id => docs.get(id)?.state as never;
  // The fixture's index has no real journal backend: reindexing restores the corresponding in-memory row.
  (storage as unknown as { syncSessionUnlocked(id: string): Promise<void> }).syncSessionUnlocked = async id => {
    rows.set(id, { id: parseSessionId(id), status: 'completed', lastSequence: 0, journalLine: 1, journal: null });
  };
  const archive = createSessionArchive({
    directory: id => createSessionPaths(paths, id).directory,
    storage,
    clock: { nowMs: () => Date.parse(NOW) },
    afterMs: 24 * 3600000,
    passLimit: 200,
    yieldToLoop: async () => {},
    sources: {
      pinned: async () => {
        keepReads++;
        if (keepReads === 2) options.duringBoundary?.(docs);
        return new Map(pins);
      },
      board: async () =>
        options.openCard?.() ? [{ dropped: null, owner: 'lead-1', assignee: null, category: 'active' as const }] : [],
      hasOpenAgendaItem: async () => options.openAgenda?.() ?? false,
    },
  });
  return { archive, storage, docs, rows, pins, serial };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

export function sessionArchiveCommitContract(): void {
  test('unknown lineage still blocks when an existing running config becomes unreadable before locks', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        [
          'kid-1',
          {
            config: { mode: 'auto' },
            state: { status: 'running' },
          },
        ],
      ]),
      beforeLocks: docs => {
        const kid = docs.get('kid-1');
        if (kid) kid.config = undefined;
      },
    });
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('an unreadable ended child is retained and must not permit its possible lead to leave', async () => {
    const kid = ended('lead-1');
    kid.config = undefined;
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['kid-1', kid],
      ]),
    });
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('a child created during boundary keep reads keeps its lead live', async () => {
    const world = fixture({
      duringBoundary: docs => {
        docs.set('kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } });
      },
    });
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('a known running session whose parent changes before the locks keeps its new lead', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        [
          'kid-1',
          {
            config: { mode: 'auto' },
            state: { status: 'running' },
          },
        ],
      ]),
      beforeLocks: docs => {
        const kid = docs.get('kid-1');
        if (kid) kid.config = { mode: 'auto', parent: 'lead-1' };
      },
    });
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('lifecycle child publication during registry IO retains its lead before publishing', async () => {
    let creation: Promise<void> | undefined;
    let once = false;
    const world = fixture({
      beforePersist: () => {
        if (once) return;
        once = true;
        creation = repository.write(
          {
            config: { id: 'kid-1', parent: 'lead-1', mode: 'auto', agent: '/fleet/claude-auto' },
            state: { id: 'kid-1', status: 'created' },
          } as never,
          { type: 'session.created', data: {} },
        );
      },
    });
    const repository = new StorageSessionLifecycleRepository(world.storage);
    world.storage.upsertConfig = async (id, transform) => {
      expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
      const config = transform(undefined) as Record<string, unknown>;
      world.docs.set(id, { config, state: { status: 'created' } });
      return config as never;
    };
    world.storage.upsertState = async () => ({}) as never;
    world.storage.append = async () => ({}) as never;
    await world.archive.subsystem.run?.();
    expect(creation).toBeDefined();
    await creation;
    expect(world.docs.has('kid-1')).toBe(true);
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
    expect(world.rows.has('lead-1')).toBe(true);
  });

  test('a keep publication during registry IO cancels that commit without a stale index removal', async () => {
    let retaining: Promise<void> | undefined;
    let once = false;
    const world = fixture({
      beforePersist: () => {
        if (once) return;
        once = true;
        retaining = world.storage.retainSession(parseSessionId('lead-1'));
      },
    });
    await world.archive.subsystem.run?.();
    await retaining;
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
    expect(world.rows.has('lead-1')).toBe(true);
  });

  test('retaining an archived child restores the child, its lead and both live index rows idempotently', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['kid-1', ended('lead-1')],
      ]),
    });
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(true);
    await world.storage.retainSession(parseSessionId('kid-1'));
    await world.storage.retainSession(parseSessionId('kid-1'));
    expect(world.storage.archivedCount()).toBe(0);
    expect([...world.rows.keys()].sort()).toEqual(['kid-1', 'lead-1']);
  });

  test('a config writer queued during registry IO completes and restores membership after the gates are released', async () => {
    let written: Promise<void> | undefined;
    let once = false;
    const world = fixture({
      beforePersist: () => {
        if (once) return;
        once = true;
        written = world.storage.writeConfig(parseSessionId('lead-1'), { mode: 'auto' });
      },
    });
    const documents = world.storage as unknown as {
      assertJournalKept(id: string): Promise<void>;
      writeDocument(kind: string, id: string, value: unknown): Promise<void>;
    };
    documents.assertJournalKept = async () => {};
    documents.writeDocument = async () => {};
    await world.archive.subsystem.run?.();
    await written;
    expect(written).toBeDefined();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
    expect(world.rows.has('lead-1')).toBe(true);
  });

  test('simultaneous retentions of unrelated archived sessions preserve both registry removals', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['other-1', ended()],
      ]),
    });
    await world.archive.subsystem.run?.();
    await Promise.all(['lead-1', 'other-1'].map(async id => await world.storage.retainSession(parseSessionId(id))));
    expect(world.storage.archivedCount()).toBe(0);
    expect([...world.rows.keys()].sort()).toEqual(['lead-1', 'other-1']);
  });

  test('a pin added while registry IO is pending keeps its session live', async () => {
    const world = fixture({
      beforePersist: (_docs, pins) => {
        pins.set('lead-1', NOW);
      },
    });
    await world.archive.subsystem.run?.();
    expect(world.pins.has('lead-1')).toBe(true);
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  for (const signal of ['card', 'agenda'] as const) {
    test(`an already open ${signal} keeps its session live (control)`, async () => {
      const world = fixture(signal === 'card' ? { openCard: () => true } : { openAgenda: () => true });
      await world.archive.subsystem.run?.();
      expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
    });

    test(`a late open ${signal} keeps its session live`, async () => {
      let open = false;
      const world = fixture({
        beforePersist: () => {
          open = true;
        },
        ...(signal === 'card' ? { openCard: () => open } : { openAgenda: () => open }),
      });
      await world.archive.subsystem.run?.();
      expect(open).toBe(true);
      expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
    });
  }

  test('an archive remains recoverable by the normal write revival primitive', async () => {
    const world = fixture();
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(true);
    const internal = world.storage as unknown as { reviveIfArchived(id: string): Promise<void> };
    await internal.reviveIfArchived('lead-1');
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('a revival queued on a held lane completes after the finite archive pass', async () => {
    let queued: Promise<void> | undefined;
    let once = false;
    const world = fixture({
      beforePersist: () => {
        if (once) return;
        once = true;
        const internal = world.storage as unknown as { reviveIfArchived(id: string): Promise<void> };
        queued = world.serial.run('lead-1', () => internal.reviveIfArchived('lead-1'));
      },
    });
    await world.archive.subsystem.run?.();
    expect(queued).toBeDefined();
    await queued;
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });
  for (const sweep of ['reconcile', 'rebuildIndex'] as const) {
    for (const held of [false, true]) {
      test(`successful retention ${held ? 'inside a board hold' : 'without document lanes'} keeps its row during ${sweep}`, async () => {
        // Arrange: the fixture's state port holds only the documents; no real IO occurs.
        const persisting = deferred();
        const finish = deferred();
        let pause = false;
        const world = fixture({
          beforePersist: async () => {
            if (!pause) return;
            persisting.resolve();
            await finish.promise;
          },
        });
        const id = parseSessionId('lead-1');
        await world.archive.subsystem.run?.();
        const internal = world.storage as unknown as {
          index: {
            listSessions(): readonly unknown[];
            refreshSession(session: Parameters<typeof world.rows.set>[1]): void;
            countEvents(): number;
            replaceAll(plan: { sessions: readonly Parameters<typeof world.rows.set>[1][] }): void;
          };
          serial: { runExclusive<T>(work: () => Promise<T>): Promise<T> };
        };
        // Use the actual index semantics: restored rows are visible immediately, even while archive membership remains.
        internal.index.listSessions = () => [...world.rows.values()];
        internal.index.refreshSession = session => {
          world.rows.set(session.id, session);
        };
        internal.index.countEvents = () => 0;
        internal.index.replaceAll = plan => {
          world.rows.clear();
          for (const session of plan.sessions) world.rows.set(session.id, session);
        };
        internal.serial.runExclusive = world.serial.runExclusive.bind(world.serial);
        pause = true;
        // Act: retention has built the live row and is now persisting removal of archive membership.
        const retaining = held
          ? world.storage.holdSessions([id], () => world.storage.retainSession(id))
          : world.storage.retainSession(id);
        await persisting.promise;
        expect(world.rows.has(id)).toBe(true);
        expect(world.storage.isArchived(id)).toBe(true);
        try {
          // Actual collectObservations skips archived dirs; actual reconciliation forgets the apparent stale live row.
          const reconciling = world.storage[sweep]();
          await new Promise<void>(resolve => setImmediate(resolve));
          finish.resolve();
          const [, reconciled] = await Promise.all([retaining, reconciling]);
          expect(reconciled.problems).toEqual([]);
        } finally {
          finish.resolve();
          await retaining;
        }
        // Assert: a successful keep must leave the session live after both operations settle.
        expect(world.storage.isArchived(id)).toBe(false);
        expect(world.rows.has(id)).toBe(true);
      });
    }
  }
}
