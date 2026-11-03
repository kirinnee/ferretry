import { describe, it } from 'bun:test';
import type { BoardTask, BoardTaskId, BoardTaskView } from '@ferretry/protocol';
import should from 'should';
import { StorageSessionRoster } from '../../../src/adapters/board/session-roster.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  BoardService,
  BoardSweep,
  EMPTY_SWEEP_MEMORY,
  HELPER_ENDED_GRACE_MS,
  lineageThrough,
  MAX_LINEAGE_DEPTH,
  type SweepBoard,
} from '../../../src/lib/board/index.ts';
import type { BoardWrite } from '../../../src/lib/board/index.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import { card, liveSession, MemoryBoardStore, NOW, PROJECT, lanes, rosterOf, world } from './support.ts';

/**
 * A return is atomic with the sessions it rests on: the lanes of the ferret, the ended ones above it and the lead are
 * held from the fresh read of their standing until the card is on disk, so a stop, a completion or a resume of any of
 * them cannot land in between. Every test pauses the commit at the interval a race would need, changes a session
 * there, and checks that the change waits (the return serializes BEFORE the transition) or that the return declines
 * (the transition was already queued ahead of it).
 */

const old = new Date(Date.parse(NOW) - HELPER_ENDED_GRACE_MS - 1000).toISOString();
const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);
const links = {
  prs: [
    {
      url: 'https://github.com/kirinnee/ferretry/pull/950',
      number: 950,
      repo: 'kirinnee/ferretry',
      state: 'open' as const,
      draft: false,
      checks: 'none' as const,
      mergedAt: null,
      mergeSha: null,
      releasedIn: null,
      polledAt: NOW,
    },
  ],
  branch: null,
  commits: [],
  docs: [],
};

const stored = (): BoardTask =>
  card({ id: 'F2', parent: { id: 'F1' }, owner: 'lead', assignee: 'grandchild', laneId: 'review', links });

const planned = (task: BoardTask): SweepBoard => {
  const view: BoardTaskView = {
    ...task,
    lastTouchedAt: old,
    touchedBy: null,
    activity: 'idle',
    rollup: {
      children: 0,
      byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
      active: 0,
      lastTouchedAt: null,
    },
    suggestedLane: null,
    waitingOnOwner: [],
    openAsks: [],
    blockedBy: [],
    blocks: [],
    shippedIn: null,
  };
  return { views: [view], laneSets };
};

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Lets every pending continuation run, so "has not landed yet" means the write is really queued behind a hold. */
const settleQueue = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(1);
};

/** Session documents in memory with the storage's lane discipline: a write takes its session's lane, a read does not. */
class LanedSessions {
  readonly serial = new KeyedSerialExecutor();
  /** Everything that landed, in order: session transitions and the card, as one timeline. */
  readonly landed: string[] = [];
  private readonly configs = new Map<string, unknown>();
  private readonly states = new Map<string, unknown>();

  put(id: string, status: string, parent?: string): void {
    this.configs.set(id, Object.freeze({ id, ...(parent === undefined ? {} : { parent }) }));
    this.states.set(id, Object.freeze({ id, status }));
  }

  /** A status write, as the lifecycle and the signal service make them; `gate` holds the lane while it runs. */
  async write(id: string, status: string, gate?: Promise<void>): Promise<void> {
    await this.serial.run(id, async () => {
      await gate;
      this.states.set(id, Object.freeze({ id, status }));
      this.landed.push(`${id}:${status}`);
    });
  }

  readonly storage = {
    listSessions: () =>
      [...this.states.keys()].map(id => ({ id: parseSessionId(id), lastSequence: 1, journalLine: 1, journal: null })),
    readConfig: async (id: string) => this.configs.get(id) as never,
    readState: async (id: string) => this.states.get(id) as never,
    holdSessions: async <T>(ids: readonly string[], work: () => Promise<T>) => await this.serial.runAcross(ids, work),
  };
}

/** A card store that notes when the card lands, and can stand still just before it decides or just after. */
class GatedStore extends MemoryBoardStore {
  beforeDecide: (() => Promise<void>) | undefined;
  afterDecide: (() => Promise<void>) | undefined;

  constructor(
    cards: readonly BoardTask[],
    private readonly timeline: string[],
  ) {
    super(cards);
  }

  override async write<T>(id: BoardTaskId, decide: (current: BoardTask | undefined) => Promise<BoardWrite<T>>) {
    await this.beforeDecide?.();
    return await super.write(id, async current => {
      const decision = await decide(current);
      await this.afterDecide?.();
      if (decision.task !== null) this.timeline.push(`card:${decision.task.assignee}`);
      return decision;
    });
  }
}

const harness = (sessions: LanedSessions) => {
  const store = new GatedStore([stored()], sessions.landed);
  const service = new BoardService(world({ store }));
  const roster = new StorageSessionRoster(sessions.storage, () => undefined);
  const sweep = new BoardSweep({
    board: {
      sweepBoard: async () => planned(stored()),
      closeEndedHelper: async () => false,
      returnToLead: async (id, plan, settle) => await service.returnToLead(id, plan, settle),
    },
    sessions: roster,
    guard: roster,
    memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
    nudges: { send: async () => undefined },
    clock: { now: () => NOW },
    diagnostics: { warn: () => undefined },
  });
  return { store, sweep };
};

/** `lead` > `child` > `grandchild`, the grandchild's work finished. */
const fleet = (): LanedSessions => {
  const sessions = new LanedSessions();
  sessions.put('lead', 'running');
  sessions.put('child', 'running', 'lead');
  sessions.put('grandchild', 'completed', 'child');
  return sessions;
};

describe('a return racing a session transition', () => {
  it('should let a lead that stops after the fresh read wait until the card has landed', async () => {
    // Arrange
    const sessions = fleet();
    const { store, sweep } = harness(sessions);
    const reached = deferred();
    const release = deferred();
    store.afterDecide = async () => {
      reached.resolve();
      await release.promise;
    };

    // Act — the commit has read the lead alive and decided; now the lead ends
    const tick = sweep.tick();
    await reached.promise;
    const stopping = sessions.write('child', 'stopped');
    await settleQueue();
    const landedWhilePaused = [...sessions.landed];
    release.resolve();
    const report = await tick;
    await stopping;

    // Assert — the stop did not land inside the interval; it serialized after the return
    should(landedWhilePaused).eql([]);
    should(report.returned).eql(['F2']);
    should(sessions.landed).eql(['card:child', 'child:stopped']);
  });

  it('should let a worker that resumes after the fresh read wait until the card has landed', async () => {
    // Arrange
    const sessions = fleet();
    const { store, sweep } = harness(sessions);
    const reached = deferred();
    const release = deferred();
    store.afterDecide = async () => {
      reached.resolve();
      await release.promise;
    };

    // Act
    const tick = sweep.tick();
    await reached.promise;
    const resuming = sessions.write('grandchild', 'running');
    await settleQueue();
    const landedWhilePaused = [...sessions.landed];
    release.resolve();
    await tick;
    await resuming;

    // Assert
    should(landedWhilePaused).eql([]);
    should(sessions.landed).eql(['card:child', 'grandchild:running']);
  });

  it('should not wait for the whole fleet: a session outside the line writes while the return is paused', async () => {
    // Arrange
    const sessions = fleet();
    sessions.put('stranger', 'running');
    const { store, sweep } = harness(sessions);
    const reached = deferred();
    const release = deferred();
    store.afterDecide = async () => {
      reached.resolve();
      await release.promise;
    };

    // Act
    const tick = sweep.tick();
    await reached.promise;
    await sessions.write('stranger', 'stopped');
    release.resolve();
    await tick;

    // Assert
    should(sessions.landed).eql(['stranger:stopped', 'card:child']);
  });

  it('should decline when the lead ended before the hold was taken, even though the plan saw it alive', async () => {
    // Arrange — a stop already in flight holds the lead's lane when the tick plans
    const sessions = fleet();
    const { sweep, store } = harness(sessions);
    const stop = deferred();
    const stopping = sessions.write('child', 'stopped', stop.promise);

    // Act
    const tick = sweep.tick();
    await settleQueue();
    stop.resolve();
    const report = await tick;
    await stopping;

    // Assert — the fresh read saw the stop; the card stayed with the ended ferret for the next sweep to plan afresh
    should(report.returned).eql([]);
    should(store.cards.get('F2')?.assignee).equal('grandchild');
    should(sessions.landed).eql(['child:stopped']);
  });

  it('should decline when the worker was resumed before the hold was taken', async () => {
    // Arrange
    const sessions = fleet();
    const { sweep, store } = harness(sessions);
    const resume = deferred();
    const resuming = sessions.write('grandchild', 'running', resume.promise);

    // Act
    const tick = sweep.tick();
    await settleQueue();
    resume.resolve();
    const report = await tick;
    await resuming;

    // Assert
    should(report.returned).eql([]);
    should(store.cards.get('F2')?.assignee).equal('grandchild');
  });

  it('should hold the ended ferret between too, so a revived middle lead cannot be skipped', async () => {
    // Arrange — lead > mid (ended) > leaf (ended): the return rests on mid staying ended
    const sessions = new LanedSessions();
    sessions.put('lead', 'running');
    sessions.put('mid', 'stopped', 'lead');
    sessions.put('grandchild', 'completed', 'mid');
    const { sweep, store } = harness(sessions);
    const reached = deferred();
    const release = deferred();
    store.afterDecide = async () => {
      reached.resolve();
      await release.promise;
    };

    // Act
    const tick = sweep.tick();
    await reached.promise;
    const reviving = sessions.write('mid', 'running');
    await settleQueue();
    const landedWhilePaused = [...sessions.landed];
    release.resolve();
    await tick;
    await reviving;

    // Assert
    should(landedWhilePaused).eql([]);
    should(sessions.landed).eql(['card:lead', 'mid:running']);
  });
});

describe('the sessions a return holds', () => {
  it('should be the ferret, every one above it, and the lead, in order', () => {
    // Arrange
    const roster = rosterOf([
      liveSession('lead'),
      liveSession('mid', { lead: 'lead', status: 'stopped' }),
      liveSession('leaf', { lead: 'mid', status: 'completed' }),
    ]);

    // Act / Assert
    should(lineageThrough(roster, 'leaf', 'lead')).eql(['leaf', 'mid', 'lead']);
    should(lineageThrough(roster, 'leaf', 'mid')).eql(['leaf', 'mid']);
  });

  it('should be nothing when the lead is not above the ferret or the chain loops', () => {
    // Arrange
    const roster = rosterOf([
      liveSession('a', { lead: 'b', status: 'stopped' }),
      liveSession('b', { lead: 'a', status: 'stopped' }),
      liveSession('other'),
    ]);

    // Act / Assert
    should(lineageThrough(roster, 'a', 'other')).be.null();
    should(lineageThrough(roster, 'other', 'a')).be.null();
  });

  it('should be nothing when the lead sits above the lineage depth cap', () => {
    // Arrange: s0 -> s1 -> ... -> top, every session between gone, the top farther up than the walk goes
    const depth = MAX_LINEAGE_DEPTH + 10;
    const roster = rosterOf([
      liveSession('top'),
      ...Array.from({ length: depth }, (_, index) =>
        liveSession(`s${index}`, { lead: index === depth - 1 ? 'top' : `s${index + 1}`, status: 'stopped' }),
      ),
    ]);

    // Act / Assert
    should(lineageThrough(roster, 's0', `s${MAX_LINEAGE_DEPTH - 1}`)).have.length(MAX_LINEAGE_DEPTH);
    should(lineageThrough(roster, 's0', 'top')).be.null();
  });
});

describe('holding several keys at once', () => {
  it('should not deadlock two holds that name the same keys in opposite orders', async () => {
    // Arrange
    const serial = new KeyedSerialExecutor();
    const order: string[] = [];

    // Act
    await Promise.all([
      serial.runAcross(['a', 'b'], async () => void order.push('first')),
      serial.runAcross(['b', 'a'], async () => void order.push('second')),
    ]);

    // Assert
    should(order).eql(['first', 'second']);
  });

  it('should not deadlock when an exclusive pass queues between the hold and its work', async () => {
    // Arrange
    const serial = new KeyedSerialExecutor();
    const release = deferred();
    const inside = deferred();
    const hold = serial.runAcross(['a', 'b'], async () => {
      inside.resolve();
      await release.promise;
      return 'held';
    });
    await inside.promise;

    // Act — an exclusive pass now waits for the hold; the hold must not be waiting on that pass
    const exclusive = serial.runExclusive(async () => 'exclusive');
    release.resolve();

    // Assert
    should(await hold).equal('held');
    should(await exclusive).equal('exclusive');
  });

  it('should keep other keys running and queue a later write to a held key behind the work', async () => {
    // Arrange
    const serial = new KeyedSerialExecutor();
    const release = deferred();
    const inside = deferred();
    const order: string[] = [];
    const hold = serial.runAcross(['a', 'b'], async () => {
      inside.resolve();
      await release.promise;
      order.push('hold');
    });
    await inside.promise;

    // Act
    const later = serial.run('b', async () => void order.push('later'));
    await serial.run('c', async () => void order.push('other'));
    release.resolve();
    await Promise.all([hold, later]);

    // Assert
    should(order).eql(['other', 'hold', 'later']);
  });

  it('should release the keys when the work throws', async () => {
    // Arrange
    const serial = new KeyedSerialExecutor();

    // Act
    const failed = await serial
      .runAcross(['a'], async () => {
        throw new Error('boom');
      })
      .catch((error: unknown) => (error as Error).message);

    // Assert
    should(failed).equal('boom');
    should(await serial.run('a', async () => 'free')).equal('free');
  });
});
