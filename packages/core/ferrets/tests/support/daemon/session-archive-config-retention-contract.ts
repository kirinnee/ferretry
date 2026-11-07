import { expect, test } from 'bun:test';
import { fixture, ended } from './session-archive-commit-contract.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { StorageSessionLifecycleRepository } from '../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { createSessionArchive } from '../../../daemon/adapters/session/archive/session-archive.ts';
import { createFoundationPaths } from '../../../daemon/lib/paths.ts';
import { parseArchiveAfter } from '../../../daemon/lib/session/archive/policy.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The storage's document IO, routed through a facade a test may rewire: `/<id>/<kind>.json` paths and JSON text. */
interface DocumentFacade {
  assertJournalKept(id: string): Promise<void>;
  readDocument(id: string, kind: 'config' | 'state'): Promise<unknown>;
  writeDocument(path: string, value: string): Promise<void>;
}

function writable(world: ReturnType<typeof fixture>): DocumentFacade {
  const facade: DocumentFacade = {
    assertJournalKept: async () => {},
    readDocument: async (id, kind) => world.docs.get(id)?.[kind],
    writeDocument: async (path, value) => {
      const id = path.split('/').at(-2) ?? '';
      const doc = world.docs.get(id);
      if (doc === undefined) throw new Error(`missing fixture document ${id}`);
      doc.config = JSON.parse(value);
    },
  };
  const storage = world.storage as unknown as {
    assertJournalKept(id: string): Promise<void>;
    readDocument(id: string, kind: 'config' | 'state'): Promise<unknown>;
    writeDocument(kind: 'config' | 'state', id: string, value: unknown): Promise<void>;
  };
  storage.assertJournalKept = async id => await facade.assertJournalKept(id);
  storage.readDocument = async (id, kind) => await facade.readDocument(id, kind);
  storage.writeDocument = async (kind, id, value) =>
    await facade.writeDocument(`/${id}/${kind}.json`, JSON.stringify(value));
  return facade;
}

export function sessionArchiveConfigRetentionContract(): void {
  test('the default disables automatic passes, explicit hours enable them, and reads and revival stay available', async () => {
    const world = fixture();
    const archive = (raw: string | undefined) =>
      createSessionArchive({
        paths: createFoundationPaths('/tmp/review-only-no-io' as never),
        storage: world.storage,
        clock: { nowMs: () => Date.parse('2026-11-06T12:00:00.000Z') },
        afterMs: parseArchiveAfter(raw),
        passLimit: 200,
        sources: {
          pinned: async () => new Map(),
          board: async () => [],
          hasOpenAgendaItem: async () => false,
        },
        yieldToLoop: async () => {},
      });
    const disabled = archive(undefined);
    expect(disabled.enabled).toBe(false);
    expect(disabled.subsystem.run).toBeUndefined();
    expect(await disabled.subsystem.count()).toBe(0);
    expect(await disabled.subsystem.list(10)).toEqual([]);
    const enabled = archive('24');
    expect(enabled.enabled).toBe(true);
    await enabled.subsystem.run?.();
    expect(await disabled.subsystem.count()).toBe(1);
    await world.storage.retainSession(parseSessionId('lead-1'));
    expect(await disabled.subsystem.count()).toBe(0);
    expect(world.rows.has('lead-1')).toBe(true);
  });

  for (const method of ['writeConfig', 'updateConfig', 'upsertConfig'] as const) {
    test(
      method + ': preserves the original error before config publication even if parent proof would fail',
      async () => {
        const world = fixture();
        const internal = writable(world);
        const original = new TypeError('foreign session directory');
        let refused = false;
        internal.assertJournalKept = async () => {
          refused = true;
          throw original;
        };
        const read = world.storage.readConfig.bind(world.storage);
        world.storage.readConfig = async (id, freshness) => {
          if (refused) throw new Error('foreign directory has no proved config');
          return await read(id, freshness);
        };
        const id = parseSessionId('lead-1');
        const written =
          method === 'writeConfig' ? world.storage.writeConfig(id, {}) : world.storage[method](id, () => ({}));
        await expect(written).rejects.toBe(original);
        expect(world.docs.get(id)?.config).toEqual({ mode: 'auto' });
      },
    );
  }

  for (const method of ['writeConfig', 'updateConfig', 'upsertConfig'] as const) {
    test(`${method} already publishing holds its current root gate until the index is published`, async () => {
      const world = fixture({
        docs: new Map([
          ['lead-1', ended()],
          ['kid-1', ended('lead-1')],
          ['other-1', ended()],
        ]),
      });
      const documents = writable(world);
      const write = documents.writeDocument;
      const started = deferred();
      const finish = deferred();
      documents.writeDocument = async (path, value) => {
        if (path.includes('/kid-1/')) {
          started.resolve();
          await finish.promise;
        }
        await write(path, value);
      };
      const id = parseSessionId('kid-1');
      const config = { mode: 'auto', parent: 'lead-1', name: 'Renamed' };
      const written =
        method === 'writeConfig' ? world.storage.writeConfig(id, config) : world.storage[method](id, () => config);
      await started.promise;
      let verified = false;
      const archiving = world.storage.archiveSessions([parseSessionId('lead-1')], async () => {
        verified = true;
        return undefined;
      });
      try {
        // Unrelated roots finish while this writer is held. Draining the immediate then settles every ready
        // microtask, so an unprotected archive would already have entered verification.
        await world.storage.writeConfig(parseSessionId('other-1'), { mode: 'auto' });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(verified).toBe(false);
      } finally {
        finish.resolve();
        await Promise.all([written, archiving]);
      }
      expect(verified).toBe(true);
      expect(world.docs.get('kid-1')?.config?.name).toBe('Renamed');
    });
  }

  test('reparenting during the new lead commit revives that lead after publication without holding two gates', async () => {
    const persisting = deferred();
    const finishCommit = deferred();
    const retaining = deferred();
    const finishRetention = deferred();
    let once = false;
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['lead-2', ended()],
        ['kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } }],
      ]),
      beforePersist: async () => {
        if (once) return;
        once = true;
        persisting.resolve();
        await finishCommit.promise;
      },
    });
    writable(world);
    const retain = world.storage.retainSession.bind(world.storage);
    world.storage.retainSession = async id => {
      if (id === parseSessionId('lead-2')) {
        retaining.resolve();
        await finishRetention.promise;
      }
      await retain(id);
    };
    const archiving = world.archive.subsystem.run?.();
    await persisting.promise;
    const written = world.storage.updateConfig(parseSessionId('kid-1'), current => ({
      ...(current as Record<string, unknown>),
      parent: 'lead-2',
    }));
    await retaining.promise;
    expect(world.docs.get('kid-1')?.config?.parent).toBe('lead-2');
    // The writer must have released the old root before trying to retain the new one.
    let oldRootAvailable = false;
    await world.storage.archiveSessions([parseSessionId('lead-1')], async () => {
      oldRootAvailable = true;
      return undefined;
    });
    expect(oldRootAvailable).toBe(true);
    finishCommit.resolve();
    await archiving;
    expect(world.storage.isArchived(parseSessionId('lead-2'))).toBe(true);
    finishRetention.resolve();
    await written;
    expect(world.storage.isArchived(parseSessionId('lead-2'))).toBe(false);
    expect(world.rows.has('lead-2')).toBe(true);
  });

  test('lifecycle publishChild can call the real gated upsert without waiting on itself', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['kid-1', { config: undefined, state: { status: 'created' } }],
      ]),
    });
    writable(world);
    world.storage.upsertState = async () => ({}) as never;
    world.storage.append = async () => ({}) as never;
    const repository = new StorageSessionLifecycleRepository(world.storage);
    await repository.write(
      {
        config: { id: 'kid-1', parent: 'lead-1', mode: 'auto', agent: '/fleet/claude-auto' },
        state: { id: 'kid-1', status: 'created' },
      } as never,
      { type: 'session.created', data: {} },
    );
    expect(world.docs.get('kid-1')?.config?.parent).toBe('lead-1');
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  for (const operation of ['write', 'archive'] as const) {
    test(`a queued ${operation} follows a reparented session to its current root gate`, async () => {
      const world = fixture({
        docs: new Map([
          ['lead-1', ended()],
          ['lead-2', ended()],
          ['kid-1', ended('lead-1')],
        ]),
      });
      writable(world);
      const firstHeld = deferred();
      const releaseFirst = deferred();
      const secondHeld = deferred();
      const releaseSecond = deferred();
      const internal = world.storage as unknown as {
        lineages: { run<T>(key: string, work: () => Promise<T>): Promise<T> };
      };
      const holdingFirst = internal.lineages.run('lead-1', async () => {
        firstHeld.resolve();
        await releaseFirst.promise;
      });
      await firstHeld.promise;
      const holdingSecond = world.storage.archiveSessions([parseSessionId('lead-2')], async () => {
        secondHeld.resolve();
        await releaseSecond.promise;
        return undefined;
      });
      await secondHeld.promise;
      const first = world.storage.writeConfig(parseSessionId('kid-1'), { mode: 'auto', parent: 'lead-2' });
      // Both operations resolve their initial roots and queue behind the first gate before it is released.
      await new Promise<void>(resolve => setImmediate(resolve));
      let entered = false;
      const next =
        operation === 'write'
          ? world.storage.updateConfig(parseSessionId('kid-1'), current => {
              entered = true;
              return current;
            })
          : world.storage.archiveSessions([parseSessionId('kid-1')], async () => {
              entered = true;
              return undefined;
            });
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseFirst.resolve();
      await first;
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(entered).toBe(false);
      } finally {
        releaseSecond.resolve();
        await Promise.all([holdingFirst, holdingSecond, next]);
      }
      expect(entered).toBe(true);
    });

    test(`a ${operation} stops with a retry error when its root keeps moving`, async () => {
      const world = fixture();
      writable(world);
      const internal = world.storage as unknown as { ancestors(id: string): Promise<readonly string[]> };
      let reads = 0;
      internal.ancestors = async () => ['kid-1', ++reads % 2 === 0 ? 'lead-2' : 'lead-1'];
      const pending =
        operation === 'write'
          ? world.storage.writeConfig(parseSessionId('kid-1'), { mode: 'auto' })
          : world.storage.archiveSessions([parseSessionId('kid-1')], async () => ({}));
      await expect(pending).rejects.toThrow('retry');
      expect(reads).toBeLessThanOrEqual(8);
    });
  }

  test('a config rename that lands before a write error still restores its new parent after releasing the gate', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['lead-2', ended()],
        ['kid-1', ended('lead-1')],
      ]),
    });
    await world.storage.archiveSessions([parseSessionId('lead-2')], async () => ({}));
    const documents = writable(world);
    const write = documents.writeDocument;
    documents.writeDocument = async (path, value) => {
      await write(path, value);
      throw new Error('rename landed before fsync EIO');
    };
    await expect(
      world.storage.writeConfig(parseSessionId('kid-1'), { mode: 'auto', parent: 'lead-2' }),
    ).rejects.toThrow('rename landed before fsync EIO');
    expect(world.docs.get('kid-1')?.config?.parent).toBe('lead-2');
    expect(world.storage.isArchived(parseSessionId('lead-2'))).toBe(false);
    expect(world.rows.has('lead-2')).toBe(true);
  });

  test('a config mutation already pending at verification cannot change lineage and let its live lead archive', async () => {
    const started = deferred();
    const finish = deferred();
    let written: Promise<void>;
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['kid-1', { config: { mode: 'auto' }, state: { status: 'running' } }],
      ]),
    });
    const internal = writable(world);
    internal.writeDocument = async (_path, value) => {
      started.resolve();
      await finish.promise;
      const doc = world.docs.get('kid-1');
      if (doc === undefined) throw new Error('missing fixture child');
      doc.config = JSON.parse(value);
    };
    written = world.storage.writeConfig(parseSessionId('kid-1'), { mode: 'auto', parent: 'lead-1' });
    await started.promise;
    const readState = world.storage.readState.bind(world.storage);
    let reads = 0;
    world.storage.readState = async (id, freshness) => {
      if (id === parseSessionId('lead-1') && ++reads === 3) {
        finish.resolve();
        await written;
      }
      return await readState(id, freshness);
    };
    await world.archive.subsystem.run?.();
    await written;
    expect(world.docs.get('kid-1')?.config?.parent).toBe('lead-1');
    expect(world.docs.get('kid-1')?.state.status).toBe('running');
    expect(world.storage.isArchived(parseSessionId('lead-1'))).toBe(false);
  });

  test('retain retries restore the index after a transient rebuild failure', async () => {
    const world = fixture();
    const id = parseSessionId('lead-1');
    await world.archive.subsystem.run?.();
    expect(world.storage.isArchived(id)).toBe(true);
    const internal = world.storage as unknown as { syncSessionUnlocked(id: string): Promise<void> };
    const sync = internal.syncSessionUnlocked.bind(internal);
    let once = false;
    internal.syncSessionUnlocked = async session => {
      if (!once) {
        once = true;
        throw new Error('transient journal read EIO');
      }
      await sync(session);
    };
    await expect(world.storage.retainSession(id)).rejects.toThrow('transient journal read EIO');
    expect(world.storage.isArchived(id)).toBe(true);
    await world.storage.retainSession(id);
    expect(world.storage.isArchived(id)).toBe(false);
    expect(world.rows.has(id)).toBe(true);
  });

  test('a partial child/ancestor rebuild failure preserves registry membership for retry', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['kid-1', ended('lead-1')],
      ]),
    });
    await world.archive.subsystem.run?.();
    const internal = world.storage as unknown as { syncSessionUnlocked(id: string): Promise<void> };
    const sync = internal.syncSessionUnlocked.bind(internal);
    let failed = false;
    internal.syncSessionUnlocked = async id => {
      if (id === 'lead-1' && !failed) {
        failed = true;
        throw new Error('ancestor journal EIO');
      }
      await sync(id);
    };
    await expect(world.storage.retainSession(parseSessionId('kid-1'))).rejects.toThrow('ancestor journal EIO');
    expect(world.rows.has('kid-1')).toBe(true);
    expect(world.storage.archivedCount()).toBe(2);
    await world.storage.retainSession(parseSessionId('kid-1'));
    expect(world.storage.archivedCount()).toBe(0);
    expect([...world.rows.keys()].sort()).toEqual(['kid-1', 'lead-1']);
  });

  test('retention repairs a session missing from both the archive and live index', async () => {
    const world = fixture();
    world.rows.delete('lead-1');
    await world.storage.retainSession(parseSessionId('lead-1'));
    expect(world.storage.archivedCount()).toBe(0);
    expect(world.rows.has('lead-1')).toBe(true);
  });

  test('retention keeps archive membership if a rebuild cannot produce a live index row', async () => {
    const world = fixture();
    const id = parseSessionId('lead-1');
    await world.archive.subsystem.run?.();
    const internal = world.storage as unknown as { syncSessionUnlocked(id: string): Promise<void> };
    const sync = internal.syncSessionUnlocked.bind(internal);
    internal.syncSessionUnlocked = async () => {};
    await expect(world.storage.retainSession(id)).rejects.toThrow('archive membership retained');
    expect(world.storage.isArchived(id)).toBe(true);
    internal.syncSessionUnlocked = sync;
    await world.storage.retainSession(id);
    expect(world.storage.isArchived(id)).toBe(false);
    expect(world.rows.has(id)).toBe(true);
  });
  for (const method of ['writeConfig', 'updateConfig', 'upsertConfig'] as const) {
    test(`${method}: reports a committed config proof failure and repairs its archived parent on retry`, async () => {
      // Arrange: the new lead is already archived, the child is live beneath another lead.
      const world = fixture({
        docs: new Map([
          ['lead-1', ended()],
          ['lead-2', ended()],
          ['kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } }],
        ]),
      });
      const lead = parseSessionId('lead-2');
      const kid = parseSessionId('kid-1');
      await world.storage.archiveSessions([lead], async () => ({}));
      const internal = writable(world);
      const writeDocument = internal.writeDocument;
      let published = false;
      internal.writeDocument = async (path, text) => {
        await writeDocument(path, text);
        published = true;
      };
      const read = world.storage.readConfig.bind(world.storage);
      let failed = false;
      world.storage.readConfig = async (id, freshness) => {
        if (id === kid && published && !failed) {
          failed = true;
          throw new Error('one-shot EIO proving the already-published config');
        }
        return await read(id, freshness);
      };
      const next = { mode: 'auto', parent: 'lead-2' };
      // Publication landed, so a failed proof must reject explicitly and the same write must repair it.
      const write = () =>
        method === 'writeConfig' ? world.storage.writeConfig(kid, next) : world.storage[method](kid, () => next);
      await expect(write()).rejects.toThrow('committed');
      expect(world.storage.isArchived(lead)).toBe(true);
      await write();
      // Assert: published lineage and live membership must agree after it returns.
      expect(failed).toBe(true);
      expect(world.docs.get(kid)?.config?.parent).toBe('lead-2');
      expect(world.storage.isArchived(lead)).toBe(false);
      expect(world.rows.has(lead)).toBe(true);
    });
  }

  test('retrying a config write after a failed parent rebuild actually retries parent retention', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['lead-2', ended()],
        ['kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } }],
      ]),
    });
    const lead = parseSessionId('lead-2');
    const kid = parseSessionId('kid-1');
    await world.storage.archiveSessions([lead], async () => ({}));
    writable(world);
    const internal = world.storage as unknown as {
      syncSessionUnlocked(id: string): Promise<void>;
    };
    const sync = internal.syncSessionUnlocked.bind(internal);
    let failed = false;
    internal.syncSessionUnlocked = async id => {
      if (id === lead && !failed) {
        failed = true;
        throw new Error('transient new-parent journal EIO');
      }
      await sync(id);
    };
    const next = { mode: 'auto', parent: 'lead-2' };
    // The write publishes first; retention fails but correctly leaves its archive membership for retry.
    await expect(world.storage.writeConfig(kid, next)).rejects.toThrow(
      'config write is already committed; parent retention failed: transient new-parent journal EIO',
    );
    expect(world.docs.get(kid)?.config?.parent).toBe('lead-2');
    expect(world.storage.isArchived(lead)).toBe(true);
    // The same operation now succeeds: it owes the new parent the restoration the earlier attempt could not do.
    await world.storage.writeConfig(kid, next);
    expect(world.storage.isArchived(lead)).toBe(false);
    expect(world.rows.has(lead)).toBe(true);
  });

  test('an unchanged live parent still repairs an archived ancestor in its lineage', async () => {
    const world = fixture({
      docs: new Map([
        ['lead-1', ended()],
        ['parent-1', ended('lead-1')],
        ['kid-1', { config: { mode: 'auto', parent: 'parent-1' }, state: { status: 'running' } }],
      ]),
    });
    const lead = parseSessionId('lead-1');
    await world.storage.archiveSessions([lead], async () => ({}));
    writable(world);
    await world.storage.writeConfig(parseSessionId('kid-1'), { mode: 'auto', parent: 'parent-1' });
    expect(world.storage.isArchived(lead)).toBe(false);
    expect(world.rows.has(lead)).toBe(true);
  });

  for (const method of ['writeConfig', 'updateConfig', 'upsertConfig'] as const) {
    for (const unchanged of [false, true]) {
      test(
        method +
          ': an unreadable ' +
          (unchanged ? 'unchanged' : 'new') +
          ' parent lineage rejects and an identical retry repairs every ancestor',
        async () => {
          const world = fixture({
            docs: new Map([
              ['old-lead', ended()],
              ['grand-lead', ended()],
              ['parent-1', ended('grand-lead')],
              [
                'kid-1',
                { config: { mode: 'auto', parent: unchanged ? 'parent-1' : 'old-lead' }, state: { status: 'running' } },
              ],
            ]),
          });
          const grand = parseSessionId('grand-lead');
          const parent = parseSessionId('parent-1');
          const kid = parseSessionId('kid-1');
          // Also exercise the repair decision when the immediate parent is already live.
          if (unchanged) await world.storage.archiveSessions([grand], async () => ({}));
          else await world.archive.subsystem.run?.();
          expect(world.storage.isArchived(grand)).toBe(true);
          expect(world.storage.isArchived(parent)).toBe(!unchanged);
          const internal = writable(world);
          const writeDocument = internal.writeDocument;
          let published = false;
          internal.writeDocument = async (path, text) => {
            await writeDocument(path, text);
            published = true;
          };
          const read = world.storage.readConfig.bind(world.storage);
          const failure = new Error('one-shot EIO proving the intermediate parent');
          let failed = false;
          world.storage.readConfig = async (id, freshness) => {
            if (published && id === parent && !failed) {
              expect(freshness).toBe('proved');
              failed = true;
              throw failure;
            }
            return await read(id, freshness);
          };
          const next = { mode: 'auto', parent: 'parent-1' };
          const write = () =>
            method === 'writeConfig' ? world.storage.writeConfig(kid, next) : world.storage[method](kid, () => next);
          let error: unknown;
          try {
            await write();
          } catch (caught) {
            error = caught;
          }
          expect(failed).toBe(true);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('config write is already committed');
          expect((error as Error).cause).toBe(failure);
          expect(world.docs.get(kid)?.config?.parent).toBe('parent-1');
          expect(world.storage.isArchived(grand)).toBe(true);
          expect(world.storage.isArchived(parent)).toBe(!unchanged);
          // The parent no longer changes on retry; it still owes the entire lineage restoration.
          await write();
          for (const id of [parent, grand]) {
            expect(world.storage.isArchived(id)).toBe(false);
            expect(world.rows.has(id)).toBe(true);
          }
        },
      );
    }
  }
}
