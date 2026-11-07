import { describe, it } from 'bun:test';
import should from 'should';
import {
  SessionConfigSchema,
  SessionListSchema,
  SessionViewSchema,
} from '../../../../../daemon/lib/protocol/session.ts';
import {
  createSessionDirectory,
  SESSION_LIST_BATCH,
  type SessionDirectoryPorts,
} from '../../../../../daemon/lib/session/directory/session-directory.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
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
  it('should omit 950 rollout ids from list and view while the projector still gets stored discovery evidence', async () => {
    // Arrange
    const base = sessionView('baseline-size');
    const input = {
      ...base,
      journalSequence: 7,
      config: {
        ...base.config,
        transcript: {
          v: 1,
          home: '/codex',
          identity: 'undiscovered',
          baseline: Array.from({ length: 950 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`),
          correlationToken: '/state/sessions/baseline-size',
        },
      },
    };
    const id = parseSessionId(input.config.id);
    const entry = indexed(id, 'running');
    let projectedBaseline: readonly string[] | undefined;
    const subject = createSessionDirectory({
      sessions: () => [entry],
      find: () => entry,
      readConfig: async () => input.config,
      readState: async () => input.state,
      directory: () => input.directory,
      project: async (_id, config) => {
        projectedBaseline = config.transcript?.baseline;
      },
      ended: () => false,
      yieldToLoop: async () => {},
    });
    // Act
    const listed = await subject.list();
    const viewed = await subject.get(id);
    const before = Buffer.byteLength(JSON.stringify(input));
    const after = Buffer.byteLength(JSON.stringify(viewed));
    // Assert: the fixture saves exactly the baseline key, brackets and 950 UUID strings.
    should(listed[0]?.config.transcript).not.have.property('baseline');
    should(viewed?.config.transcript).not.have.property('baseline');
    should(projectedBaseline).have.length(950);
    should(SessionConfigSchema.parse(input.config).transcript?.baseline).have.length(950);
    should(SessionViewSchema.parse(input).config.transcript).not.have.property('baseline');
    should(SessionListSchema.parse([input])[0]?.config.transcript).not.have.property('baseline');
    should(before - after).equal(37_063);
    should(listed[0]).equal(viewed);
  });

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

  /**
   * The agenda asks whether a session is there for every ferret on a board, on every board read: projected,
   * that was a transcript tail per session and one card's read took ten seconds on a 760-session host.
   */
  it('should say a live or ended session is there without projecting either', async () => {
    const f = fleet(1, 1);
    const subject = directory(f);
    should(await subject.has('live-0')).be.true();
    should(await subject.has('ended-0')).be.true();
    should(f.projected).eql([]);
    should(f.clock).equal(2 * 2 * READ_MS);
  });

  it('should say an unindexed session is not there, and refuse what the single read refuses', async () => {
    const f = fleet(2, 0);
    f.broken.add('live-1');
    const subject = directory(f);
    should(await subject.has('nobody')).be.false();
    await should(subject.has('live-1')).be.rejectedWith({ name: 'SessionReadError', failure: 'unusable' });
    await should(subject.has('../etc')).be.rejectedWith({ name: 'SessionReadError', failure: 'invalid' });
    should(f.projected).eql([]);
  });

  it('should not parse an unchanged pair of documents twice, and parse a changed one again', async () => {
    // Arrange — a reader that hands out the same frozen values until a file changes, as the storage does.
    let looks = 0;
    const counted = <T extends object>(value: T): T =>
      new Proxy(Object.freeze(value), {
        get: (target, key) => {
          if (key !== 'then') looks += 1;
          return Reflect.get(target, key);
        },
      });
    const id = parseSessionId('live-0');
    const config = counted(sessionView(id).config);
    let state = counted(sessionView(id).state);
    const subject = createSessionDirectory({
      sessions: () => [indexed('live-0', 'running')],
      find: () => indexed('live-0', 'running'),
      readConfig: async () => config,
      readState: async () => state,
      directory: () => '/state/sessions/live-0',
      ended: () => false,
      yieldToLoop: async () => undefined,
    });
    should(await subject.has('live-0')).be.true();
    const parsed = looks;

    // Act
    const again = await subject.has('live-0');
    const unchangedLooks = looks - parsed;
    state = counted({ ...sessionView(id).state, status: 'not-a-status' } as never);
    const changed = subject.has('live-0');

    // Assert
    should(again).be.true();
    should(unchangedLooks).equal(0);
    await should(changed).be.rejectedWith({ name: 'SessionReadError', failure: 'unusable' });
  });

  it('should answer nothing for an unindexed session and refuse an unusable reference', async () => {
    const subject = directory(fleet(1, 0));
    should(await subject.get('nobody')).be.undefined();
    await should(subject.get('../etc')).be.rejectedWith({ name: 'SessionReadError', failure: 'invalid' });
  });

  describe('a list of documents the reader hands out again', () => {
    /** A fleet whose documents are the same frozen values until a test replaces one, as the storage's are. */
    const stored = (count: number) => {
      const ids = Array.from({ length: count }, (_, n) => `live-${n}`);
      const configs = new Map(ids.map(id => [id, Object.freeze(sessionView(id).config)]));
      const states = new Map(ids.map(id => [id, Object.freeze(sessionView(id).state)]));
      const index = ids.map(id => indexed(id, 'running'));
      const subject = createSessionDirectory({
        sessions: () => index,
        find: id => index.find(session => session.id === id),
        readConfig: async id => configs.get(id),
        readState: async id => states.get(id),
        directory: id => `/state/sessions/${id}`,
        ended: () => false,
        yieldToLoop: async () => undefined,
      });
      return { ids, configs, states, index, subject };
    };

    it('should hand out the very same views when no document moved, and parse nothing again', async () => {
      // Arrange
      const { subject } = stored(40);
      const first = await subject.list();

      // Act
      const second = await subject.list();

      // Assert
      should(second).have.length(40);
      should(second.every((view, at) => view === first[at])).be.true();
      should(JSON.stringify(second)).equal(JSON.stringify(first));
    });

    it('should parse only the session whose document changed', async () => {
      // Arrange
      const { subject, states } = stored(40);
      const first = await subject.list();
      states.set('live-7', Object.freeze({ ...sessionView('live-7').state, status: 'stalled' }));

      // Act
      const second = await subject.list();

      // Assert
      const moved = second.flatMap((view, at) => (view === first[at] ? [] : [at]));
      should(moved).eql([7]);
      should(second[7]?.state.status).equal('stalled');
      // The unchanged config of the moved session was not parsed again either: its parse is the same object.
      should(second[7]?.config).equal(first[7]?.config);
      should(second[7]?.state).not.equal(first[7]?.state);
      should(second[8]).equal(first[8]);
    });

    it('should parse the session again when its config changed, and say so in the view', async () => {
      // Arrange
      const { subject, configs } = stored(3);
      const first = await subject.list();
      configs.set('live-1', Object.freeze(sessionView('live-1', { name: 'Renamed' }).config));

      // Act
      const second = await subject.list();

      // Assert
      should(second[1]?.config.name).equal('Renamed');
      should(second[1]).not.equal(first[1]);
      should(second[0]).equal(first[0]);
      should(second[2]).equal(first[2]);
    });

    it('should hand out a new view when only the journal moved', async () => {
      // Arrange
      const { subject, index } = stored(2);
      const first = await subject.list();
      index[0] = { ...indexed('live-0', 'running'), lastSequence: 8 };

      // Act
      const second = await subject.list();

      // Assert
      should(second[0]?.journalSequence).equal(8);
      should(second[0]).not.equal(first[0]);
      should(second[1]).equal(first[1]);
    });

    it('should judge a broken session afresh, and list it again once it is repaired', async () => {
      // Arrange
      const { subject, configs } = stored(2);
      const good = Object.freeze(sessionView('live-0').config);
      configs.set('live-0', Object.freeze({ id: 'live-0' }) as never);
      const broken = await subject.list();
      configs.set('live-0', good);

      // Act
      const repaired = await subject.list();

      // Assert
      should(broken.map(view => view.config.id)).eql(['live-1']);
      should(repaired.map(view => view.config.id)).eql(['live-0', 'live-1']);
    });

    it('should let go of a session the index no longer holds', async () => {
      // Arrange
      const { subject, index } = stored(3);
      await subject.list();
      const removed = index.splice(1, 1);

      // Act
      const after = await subject.list();

      // Assert
      should(after.map(view => view.config.id)).eql(['live-0', 'live-2']);
      should(removed).have.length(1);
    });

    it('should let go of a session the index swapped for an unusable one, though the count did not change', async () => {
      // Arrange
      const { subject, index } = stored(2);
      const first = await subject.list();
      const [kept, left] = [index[0], index[1]];
      // `live-2` is indexed but has no documents at all, so it never enters the cache: the index and the cache
      // both hold two sessions after this swap, and only membership tells them apart.
      index.splice(0, 2, kept as IndexedSession, indexed('live-2', 'running'));
      const withoutLeaver = await subject.list();
      index.splice(0, 2, kept as IndexedSession, left as IndexedSession);

      // Act
      const returned = await subject.list();

      // Assert
      should(withoutLeaver.map(view => view.config.id)).eql(['live-0']);
      should(returned.map(view => view.config.id)).eql(['live-0', 'live-1']);
      should(returned[0]).equal(first[0]);
      // Same documents, but the departed session was forgotten, so its view is built anew rather than recalled.
      should(returned[1]).not.equal(first[1]);
      should(returned[1]).eql(first[1]);
    });
  });
});
