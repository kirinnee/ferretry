import { describe, it } from 'bun:test';
import should from 'should';
import { StorageArchiveSessions } from '../../../../../daemon/adapters/session/archive/storage-archive-sessions.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();
const id = (value: string): SessionId => parseSessionId(value);

interface World {
  config: Record<string, unknown>;
  state: Record<string, unknown>;
}

type Worlds = Record<string, World | 'unreadable' | 'torn-config'>;

function storage(world: Worlds, beforeLocks: () => void = () => undefined) {
  const archived: string[][] = [];
  const names: (string | undefined)[] = [];
  return {
    archived,
    names,
    port: {
      retainSession: async () => undefined,
      listSessions: () => Object.keys(world).map(key => ({ id: id(key) }) as never),
      readConfig: async (session: SessionId) => {
        const entry = world[session];
        if (entry === 'unreadable' || entry === 'torn-config' || entry === undefined) throw new Error('torn');
        return entry.config as never;
      },
      readState: async (session: SessionId) => {
        const entry = world[session];
        if (entry === 'unreadable' || entry === undefined) throw new Error('torn');
        if (entry === 'torn-config') return { status: 'running' } as never;
        return entry.state as never;
      },
      archiveSessions: async (
        ids: readonly SessionId[],
        verify: (id: SessionId) => Promise<{ readonly name?: string } | undefined>,
      ) => {
        beforeLocks();
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

function adapter(
  world: Worlds,
  options: { beforeLocks?: () => void; keeps?: ReadonlyMap<string, string>; asked?: string[][] } = {},
) {
  const { port, archived, names } = storage(world, options.beforeLocks);
  let yields = 0;
  const reads = new StorageArchiveSessions(
    port,
    { nowMs: () => NOW },
    24 * HOUR,
    async () => {
      yields += 1;
    },
    async ids => {
      options.asked?.push([...ids]);
      return options.keeps ?? new Map();
    },
  );
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
      parentUnknown: true,
    });
  });

  it('should hand the rule a session whose parent it cannot understand as one with an unknown lineage', async () => {
    const { reads } = adapter({ 'odd-1': finished(48, { parent: 42 }) });

    const [session] = await reads.sessions();

    should(session?.parent).be.undefined();
    should(session?.parentUnknown).be.true();
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

    const left = await reads.archive(['old-1', 'revived-1', 'taken-1'], await reads.sessions());

    should(left).equal(1);
    should(archived).deepEqual([['old-1']]);
    // The name it answered to goes into the registry, so a callsign still addresses it.
    should(names).deepEqual(['mika']);
  });

  describe('at the commit boundary', () => {
    const family = (): Worlds => ({
      'lead-1': finished(72),
      'kid-1': finished(48, { parent: 'lead-1' }),
    });

    it('should archive a lead together with the children that leave before it', async () => {
      const { reads, archived } = adapter(family());

      const left = await reads.archive(['kid-1', 'lead-1'], await reads.sessions());

      should(left).equal(2);
      should(archived).deepEqual([['kid-1', 'lead-1']]);
    });

    it('should keep the lead live when its child revived after the decision and before the locks were taken', async () => {
      const world = family();
      const { reads, archived } = adapter(world, {
        beforeLocks: () => {
          world['kid-1'] = { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } };
        },
      });
      const roster = await reads.sessions();

      const left = await reads.archive(['kid-1', 'lead-1'], roster);

      should(left).equal(0);
      should(archived).deepEqual([[]]);
    });

    it('should keep the lead live when a child appeared after the roster was read', async () => {
      const world = family();
      delete world['kid-1'];
      const { reads, archived } = adapter(world, {
        beforeLocks: () => {
          world['late-1'] = { config: { mode: 'auto', parent: 'lead-1' }, state: { status: 'running' } };
        },
      });
      const roster = await reads.sessions();

      const left = await reads.archive(['lead-1'], roster);

      should(left).equal(0);
      should(archived).deepEqual([[]]);
    });

    it('should keep the lead live when a child cannot be told to leave', async () => {
      const { reads } = adapter(family());

      // Only the lead was named: its child is live and not leaving.
      should(await reads.archive(['lead-1'], await reads.sessions())).equal(0);
    });

    it('should keep every lead live while a running session has a config it cannot read', async () => {
      const { reads, archived } = adapter({ 'lead-1': finished(72), 'kid-1': 'torn-config' });
      const roster = await reads.sessions();

      should(roster.find(session => session.id === 'kid-1')?.parentUnknown).be.true();
      should(await reads.archive(['lead-1'], roster)).equal(0);
      should(archived).deepEqual([[]]);
    });

    it('should ask the keep signals again for the sessions being archived, and keep one that gained a signal', async () => {
      const asked: string[][] = [];
      const { reads, archived } = adapter(
        { 'a-1': finished(48), 'b-1': finished(48) },
        { keeps: new Map([['b-1', 'pinned']]), asked },
      );

      const left = await reads.archive(['a-1', 'b-1'], await reads.sessions());

      should(left).equal(1);
      should(archived).deepEqual([['a-1']]);
      // One question for the whole group, followed by the post-commit check of those that left.
      should(asked).deepEqual([['a-1', 'b-1'], ['a-1']]);
    });

    it('should keep a lead live when its child gained a keep signal', async () => {
      const { reads } = adapter(family(), { keeps: new Map([['kid-1', 'open agenda item']]) });

      should(await reads.archive(['kid-1', 'lead-1'], await reads.sessions())).equal(0);
    });
  });
});
