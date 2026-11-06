import { describe, it } from 'bun:test';
import should from 'should';
import { StorageArchiveSessions } from '../../../../src/adapters/session/archive/storage-archive-sessions.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();
const id = (value: string): SessionId => parseSessionId(value);

interface World {
  config: Record<string, unknown>;
  state: Record<string, unknown>;
}

function storage(world: Record<string, World | 'unreadable'>) {
  const archived: string[][] = [];
  const names: (string | undefined)[] = [];
  return {
    archived,
    names,
    port: {
      listSessions: () => Object.keys(world).map(key => ({ id: id(key) }) as never),
      readConfig: async (session: SessionId) => {
        const entry = world[session];
        if (entry === 'unreadable' || entry === undefined) throw new Error('torn');
        return entry.config as never;
      },
      readState: async (session: SessionId) => {
        const entry = world[session];
        if (entry === 'unreadable' || entry === undefined) throw new Error('torn');
        return entry.state as never;
      },
      archiveSessions: async (
        ids: readonly SessionId[],
        verify: (id: SessionId) => Promise<{ readonly name?: string } | undefined>,
      ) => {
        const left: SessionId[] = [];
        for (const session of ids) {
          const verdict = await verify(session);
          if (verdict !== undefined) {
            left.push(session);
            names.push(verdict.name);
          }
        }
        archived.push(left);
        return left;
      },
    },
  };
}

const finished = (hours: number, config: Record<string, unknown> = {}): World => ({
  config: { mode: 'auto', ...config },
  state: { status: 'completed', finishedAt: ago(hours) },
});

function adapter(world: Record<string, World | 'unreadable'>) {
  const { port, archived, names } = storage(world);
  let yields = 0;
  const reads = new StorageArchiveSessions(port, { nowMs: () => NOW }, 24 * HOUR, async () => {
    yields += 1;
  });
  return { reads, archived, names, yields: () => yields };
}

describe('the storage half of the session archive', () => {
  it('should read each live session as the four facts the rule decides on', async () => {
    const { reads } = adapter({ 'lead-1': finished(48), 'kid-1': finished(30, { parent: 'lead-1' }) });

    const sessions = await reads.sessions();

    should(sessions).deepEqual([
      { id: 'lead-1', mode: 'auto', status: 'completed', finishedAt: ago(48), parent: undefined },
      { id: 'kid-1', mode: 'auto', status: 'completed', finishedAt: ago(30), parent: 'lead-1' },
    ]);
  });

  it('should hand the rule a session it cannot read as one that is kept', async () => {
    const { reads } = adapter({ 'torn-1': 'unreadable' });

    const [session] = await reads.sessions();

    should(session).deepEqual({
      id: 'torn-1',
      mode: undefined,
      status: 'unknown',
      finishedAt: undefined,
      parent: undefined,
    });
  });

  it('should hand the loop back between batches of sessions', async () => {
    const world: Record<string, World> = {};
    for (let at = 0; at < 60; at += 1) world[`s-${String(at)}`] = finished(48);
    const { reads, yields } = adapter(world);

    should(await reads.sessions()).have.length(60);
    should(yields()).equal(2);
  });

  it('should archive only the sessions that still qualify when the lane is held, and say how many left', async () => {
    const { reads, archived, names } = adapter({
      'old-1': finished(48, { teammate: 'mika' }),
      // Revived between the decision and the archive: running again.
      'revived-1': { config: { mode: 'auto' }, state: { status: 'running' } },
      // Handed to a person since.
      'taken-1': { config: { mode: 'interactive' }, state: { status: 'completed', finishedAt: ago(48) } },
    });

    const left = await reads.archive(['old-1', 'revived-1', 'taken-1']);

    should(left).equal(1);
    should(archived).deepEqual([['old-1']]);
    // The name it answered to goes into the registry, so a callsign still addresses it.
    should(names).deepEqual(['mika']);
  });
});
