import { describe, it } from 'bun:test';
import should from 'should';
import {
  createSessionDirectory,
  SESSION_LIST_BATCH,
  type SessionDirectoryPorts,
} from '../../../../src/lib/session/directory/session-directory.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';
import type { IndexedSession } from '../../../../src/lib/storage-types.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

/** The loop budget no single slice of a list may exceed. */
const BUDGET_MS = 50;
/** What reading and parsing one document costs on a loaded host, on the fake clock. */
const READ_MS = 0.5;
/** What projecting one session costs: a transcript tail parsed. */
const PROJECT_MS = 4;

interface Fleet {
  readonly index: IndexedSession[];
  readonly broken: Set<string>;
  readonly projected: string[];
  clock: number;
  sliceStart: number;
  readonly slices: number[];
}

const fleet = (live: number, ended: number): Fleet => ({
  index: [
    ...Array.from({ length: live }, (_, n) => indexed(`live-${n}`, 'running')),
    ...Array.from({ length: ended }, (_, n) => indexed(`ended-${n}`, n % 2 === 0 ? 'completed' : 'stopped')),
  ],
  broken: new Set(),
  projected: [],
  clock: 0,
  sliceStart: 0,
  slices: [],
});

const indexed = (id: string, status: string): IndexedSession => ({
  id: parseSessionId(id),
  status,
  lastSequence: 7,
  journalLine: 7,
  journal: null,
});

const directory = (f: Fleet) => {
  const ports: SessionDirectoryPorts = {
    sessions: () => f.index,
    find: id => f.index.find(session => session.id === id),
    readConfig: async (id: SessionId) => {
      f.clock += READ_MS;
      return f.broken.has(id) ? { id } : sessionView(id).config;
    },
    readState: async (id: SessionId) => {
      f.clock += READ_MS;
      const status = f.index.find(session => session.id === id)?.status ?? 'running';
      return sessionView(id, {}, { status }).state;
    },
    directory: id => `/state/sessions/${id}`,
    project: async id => {
      f.clock += PROJECT_MS;
      f.projected.push(id);
    },
    ended: session => session.status === 'completed' || session.status === 'stopped',
    yieldToLoop: async () => {
      f.slices.push(f.clock - f.sliceStart);
      await Promise.resolve();
      f.sliceStart = f.clock;
    },
  };
  return createSessionDirectory(ports);
};

const finish = (f: Fleet): number[] => [...f.slices, f.clock - f.sliceStart];

describe('createSessionDirectory', () => {
  /**
   * The stall budget of the list (the EC2 stalls of 2026-10-30): ~500 sessions, ~30 of them live. Read in one
   * `Promise.all` and projected whole, that pass cost 500 × (two reads + a projection) ≈ 2.5 s of loop on this
   * cost model in ONE slice; paced and projecting only the live sessions, no slice may exceed the budget.
   */
  it('should list a 500-session fleet without one slice of the loop over the budget', async () => {
    const f = fleet(30, 470);
    const views = await directory(f).list();
    const slices = finish(f);
    should(views).have.length(500);
    should(slices.length).be.aboveOrEqual(Math.ceil(500 / SESSION_LIST_BATCH));
    should(Math.max(...slices)).be.belowOrEqual(BUDGET_MS);
    // The whole pass costs what the live sessions cost to project, not what the fleet would.
    should(f.clock).equal(500 * 2 * READ_MS + 30 * PROJECT_MS);
  });

  it('should stay inside the budget when every session is live and each one is projected', async () => {
    const f = fleet(100, 0);
    await directory(f).list();
    should(f.projected).have.length(100);
    should(Math.max(...finish(f))).be.belowOrEqual(BUDGET_MS);
  });

  it('should project only the sessions the index says are still live, in index order', async () => {
    const f = fleet(2, 3);
    const views = await directory(f).list();
    should(f.projected).eql(['live-0', 'live-1']);
    should(views.map(view => view.config.id)).eql(['live-0', 'live-1', 'ended-0', 'ended-1', 'ended-2']);
    should(views[0]?.journalSequence).equal(7);
    should(views[0]?.directory).equal('/state/sessions/live-0');
  });

  it('should still project an ended session read on its own', async () => {
    const f = fleet(0, 1);
    const view = await directory(f).get('ended-0');
    should(view?.state.status).equal('completed');
    should(f.projected).eql(['ended-0']);
  });

  it('should leave a session whose documents do not parse out of the list, and refuse it on its own', async () => {
    const f = fleet(2, 0);
    f.broken.add('live-1');
    const subject = directory(f);
    should((await subject.list()).map(view => view.config.id)).eql(['live-0']);
    await should(subject.get('live-1')).be.rejectedWith({ name: 'SessionReadError', failure: 'unusable' });
  });

  it('should answer nothing for an unindexed session and refuse an unusable reference', async () => {
    const subject = directory(fleet(1, 0));
    should(await subject.get('nobody')).be.undefined();
    await should(subject.get('../etc')).be.rejectedWith({ name: 'SessionReadError', failure: 'invalid' });
  });
});
