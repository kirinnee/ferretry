import { describe, it } from 'bun:test';
import should from 'should';
import { createSessionArchive } from '../../../../src/adapters/session/archive/session-archive.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';
import type { IndexedSession } from '../../../../src/lib/storage-types.ts';
import { sessionView } from '../../../unit/runtime/mounts/support.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();
const paths = createFoundationPaths('/tmp/fy-archive-test' as never);

const row = (id: string, updatedAt: string): IndexedSession & { readonly archivedAt: string } => ({
  id: parseSessionId(id),
  status: 'completed',
  updatedAt,
  lastSequence: 1,
  journalLine: 2,
  journal: null,
  archivedAt: ago(1),
});

function fakeStorage(archived: readonly (IndexedSession & { readonly archivedAt: string })[]) {
  const views = new Map(archived.map(entry => [entry.id as string, sessionView(entry.id)]));
  return {
    archivedCount: () => archived.length,
    listArchivedSessions: () => archived,
    findSession: (id: string) => archived.find(entry => entry.id === id),
    readConfig: async (id: string) => views.get(id)?.config as never,
    readState: async (id: string) => views.get(id)?.state as never,
    listSessions: () => [],
    archiveSessions: async () => [],
  };
}

function make(afterMs: number | undefined, archived = [row('older-1', ago(90)), row('newer-1', ago(30))]) {
  return createSessionArchive({
    paths,
    storage: fakeStorage(archived) as never,
    clock: { nowMs: () => NOW },
    afterMs,
    passLimit: 200,
    sources: {
      pinned: async () => new Map(),
      board: async () => ({ cards: [], laneSets: new Map() }),
      hasOpenAgendaItem: async () => false,
    },
    yieldToLoop: async () => undefined,
  });
}

describe('the session archive as the daemon builds it', () => {
  it('should count what is archived and list the newest first, limited to what was asked', async () => {
    const { subsystem } = make(24 * HOUR);

    should(subsystem.count()).equal(2);
    should((await subsystem.list(10)).map(view => view.config.id)).deepEqual(['newer-1', 'older-1']);
    should((await subsystem.list(1)).map(view => view.config.id)).deepEqual(['newer-1']);
  });

  it('should be able to run a pass when it is on, and report nothing to run when it is off', async () => {
    const on = make(24 * HOUR);
    const off = make(undefined);

    should(on.enabled).be.true();
    should(await on.subsystem.run?.()).deepEqual({ archived: 0, deferred: 0, live: 0 });
    should(off.enabled).be.false();
    should(off.subsystem.run).be.undefined();
  });

  it('should still show what was archived while archiving is off', async () => {
    const { subsystem } = make(undefined);

    should(subsystem.count()).equal(2);
    should(await subsystem.list(10)).have.length(2);
  });
});

describe('a pass of the session archive as the daemon builds it', () => {
  const OLD = ago(72);
  const card = { owner: 'busy-1', assignee: null, laneId: 'doing', projectId: 'p', dropped: null };
  const lanes = new Map([['p', { lanes: [{ id: 'doing', category: 'active' }] }]]);

  function world(openAgenda: readonly string[] = []) {
    const documents = new Map(
      ['busy-1', 'free-1', 'agenda-1', 'pinned-1'].map(id => [
        id,
        sessionView(id, { mode: 'auto', teammate: 'mika' }, { status: 'completed', finishedAt: OLD }),
      ]),
    );
    const archived: string[][] = [];
    const storage = {
      archivedCount: () => 0,
      listArchivedSessions: () => [],
      findSession: () => undefined,
      listSessions: () => [...documents.keys()].map(id => ({ id: parseSessionId(id) })),
      readConfig: async (id: string) => documents.get(id)?.config as never,
      readState: async (id: string) => documents.get(id)?.state as never,
      archiveSessions: async (
        ids: readonly string[],
        verify: (id: string) => Promise<{ readonly name?: string } | undefined>,
      ) => {
        const left: string[] = [];
        for (const id of ids) if ((await verify(id)) !== undefined) left.push(id);
        archived.push(left);
        return left;
      },
    };
    const archive = createSessionArchive({
      paths,
      storage: storage as never,
      clock: { nowMs: () => NOW },
      afterMs: 24 * HOUR,
      passLimit: 200,
      sources: {
        pinned: async () => new Map([['pinned-1', 'x']]),
        board: async () => ({ cards: [card as never], laneSets: lanes as never }),
        hasOpenAgendaItem: async id => openAgenda.includes(id),
      },
      yieldToLoop: async () => undefined,
    });
    return { archive, archived };
  }

  it('should archive what nothing keeps, and keep a pinned session, one on a live card and one with an open agenda item', async () => {
    const { archive, archived } = world(['agenda-1']);

    const result = await archive.subsystem.run?.();

    should(result).deepEqual({ archived: 1, deferred: 0, live: 3 });
    should(archived).deepEqual([['free-1']]);
  });
});

describe('a whole pass over a family of sessions', () => {
  const OLD = ago(72);

  /** A storage whose `archiveSessions` runs `beforeLocks` first, as a revive queued ahead of the lanes would. */
  function family(
    documents: Map<string, { config: Record<string, unknown>; state: Record<string, unknown> }>,
    beforeLocks: () => void = () => undefined,
  ) {
    const left: string[] = [];
    const storage = {
      archivedCount: () => 0,
      listArchivedSessions: () => [],
      findSession: () => undefined,
      listSessions: () => [...documents.keys()].map(id => ({ id })),
      readConfig: async (id: string) => {
        const config = documents.get(id)?.config;
        if (config === undefined) throw new Error('unreadable');
        return config;
      },
      readState: async (id: string) => documents.get(id)?.state,
      archiveSessions: async (ids: string[], verify: (id: string) => Promise<unknown>) => {
        beforeLocks();
        for (const id of ids) if ((await verify(id)) !== undefined) left.push(id);
        return left;
      },
    };
    const archive = createSessionArchive({
      paths,
      storage: storage as never,
      clock: { nowMs: () => NOW },
      afterMs: 24 * HOUR,
      passLimit: 200,
      sources: {
        pinned: async () => new Map(),
        board: async () => ({ cards: [], laneSets: new Map() }),
        hasOpenAgendaItem: async () => false,
      },
      yieldToLoop: async () => undefined,
    });
    return { archive, left };
  }

  type Doc = { config: Record<string, unknown>; state: Record<string, unknown> };
  const ended = (config: Record<string, unknown> = {}): Doc => ({
    config: { mode: 'auto', ...config },
    state: { status: 'completed', finishedAt: OLD },
  });

  it('should archive a lead and its child together when nothing changed', async () => {
    const { archive, left } = family(
      new Map<string, Doc>([
        ['lead-1', ended()],
        ['kid-1', ended({ parent: 'lead-1' })],
      ]),
    );

    await archive.subsystem.run?.();

    should(left).deepEqual(['kid-1', 'lead-1']);
  });

  it('should keep the lead live when its child revived between the decision and the locks', async () => {
    const documents = new Map<string, Doc>([
      ['lead-1', ended()],
      ['kid-1', ended({ parent: 'lead-1' })],
    ]);
    const { archive, left } = family(documents, () => {
      documents.set('kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } });
    });

    await archive.subsystem.run?.();

    should(left).deepEqual([]);
  });

  it('should keep the old lead live when a running child has a config it cannot read', async () => {
    const documents = new Map<string, Doc>([
      ['lead-1', ended()],
      ['kid-1', { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } }],
    ]);
    const { archive, left } = family(documents);
    // The kid's config tears after it was written: it is still listed, its state still says it is running.
    documents.get('kid-1')!.config = undefined as never;

    await archive.subsystem.run?.();

    should(left).deepEqual([]);
  });
});
