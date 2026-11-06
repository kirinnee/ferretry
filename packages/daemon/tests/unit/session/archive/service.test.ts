import { describe, it } from 'bun:test';
import should from 'should';
import type { ArchiveSession } from '../../../../src/lib/session/archive/policy.ts';
import { SessionArchiveService, type SessionArchivePorts } from '../../../../src/lib/session/archive/service.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

const finished = (id: string, hours: number, overrides: Partial<ArchiveSession> = {}): ArchiveSession => ({
  id,
  mode: 'auto',
  status: 'completed',
  finishedAt: ago(hours),
  parent: undefined,
  ...overrides,
});

function ports(sessions: readonly ArchiveSession[], kept: ReadonlyMap<string, string> = new Map()) {
  const calls = { asked: [] as string[][], archived: [] as string[][], rosters: [] as (readonly ArchiveSession[])[] };
  const port: SessionArchivePorts = {
    clock: { nowMs: () => NOW },
    sessions: async () => sessions,
    kept: async ids => {
      calls.asked.push([...ids]);
      return kept;
    },
    archive: async (ids, roster) => {
      calls.archived.push([...ids]);
      calls.rosters.push(roster);
      return ids.length;
    },
  };
  return { port, calls };
}

const SETTINGS = { afterMs: 24 * HOUR, passLimit: 200 };

describe('the session archive service', () => {
  it('should archive what qualifies and report what is left live', async () => {
    const { port, calls } = ports([finished('old', 72), finished('fresh', 2), finished('mid', 30)]);

    const result = await new SessionArchiveService(port, SETTINGS).runPass();

    should(result).deepEqual({ archived: 2, deferred: 0, live: 1 });
    should(calls.archived).deepEqual([['old', 'mid']]);
  });

  it('should hand the archive the roster the decision was made from, so the commit can check it again', async () => {
    const sessions = [finished('old', 72), finished('fresh', 2)];
    const { port, calls } = ports(sessions);

    await new SessionArchiveService(port, SETTINGS).runPass();

    should(calls.rosters).deepEqual([sessions]);
  });

  it('should ask about keep signals only for the sessions that already qualify', async () => {
    const { port, calls } = ports([
      finished('old', 72),
      finished('fresh', 2),
      finished('person', 72, { mode: 'interactive' }),
    ]);

    await new SessionArchiveService(port, SETTINGS).runPass();

    should(calls.asked).deepEqual([['old']]);
  });

  it('should not archive a session a signal keeps', async () => {
    const { port, calls } = ports([finished('a', 72), finished('b', 72)], new Map([['a', 'pinned']]));

    const result = await new SessionArchiveService(port, SETTINGS).runPass();

    should(calls.archived).deepEqual([['b']]);
    should(result?.live).equal(1);
  });

  it('should do nothing, and ask nothing, when nothing qualifies', async () => {
    const { port, calls } = ports([finished('fresh', 1)]);

    const result = await new SessionArchiveService(port, SETTINGS).runPass();

    should(result).deepEqual({ archived: 0, deferred: 0, live: 1 });
    should(calls.asked).deepEqual([]);
    should(calls.archived).deepEqual([]);
  });

  it('should bound a pass and report what waits for the next', async () => {
    const sessions = Array.from({ length: 5 }, (_, at) => finished(`s${String(at)}`, 100 + at));
    const { port, calls } = ports(sessions);

    const result = await new SessionArchiveService(port, { afterMs: 24 * HOUR, passLimit: 2 }).runPass();

    should(result).deepEqual({ archived: 2, deferred: 3, live: 3 });
    should(calls.archived[0]).have.length(2);
  });

  it('should count only the sessions the archive actually let go', async () => {
    const { port } = ports([finished('a', 72), finished('b', 72)]);
    const reluctant: SessionArchivePorts = { ...port, archive: async () => 1 };

    should((await new SessionArchiveService(reluctant, SETTINGS).runPass())?.live).equal(1);
  });

  it('should make a pass requested while one runs a no-op', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { port } = ports([finished('a', 72)]);
    const slow: SessionArchivePorts = {
      ...port,
      sessions: async () => {
        await gate;
        return [finished('a', 72)];
      },
    };
    const service = new SessionArchiveService(slow, SETTINGS);

    const first = service.runPass();
    const second = await service.runPass();
    release();

    should(second).be.undefined();
    should((await first)?.archived).equal(1);
    should(await service.runPass()).not.be.undefined();
  });

  it('should let a failed pass be followed by another', async () => {
    const { port } = ports([finished('a', 72)]);
    let fail = true;
    const flaky: SessionArchivePorts = {
      ...port,
      sessions: async () => {
        if (fail) throw new Error('unreadable');
        return [finished('a', 72)];
      },
    };
    const service = new SessionArchiveService(flaky, SETTINGS);

    await should(service.runPass()).be.rejectedWith('unreadable');
    fail = false;
    should((await service.runPass())?.archived).equal(1);
  });
});
