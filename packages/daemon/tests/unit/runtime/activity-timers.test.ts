import { describe, it } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import should from 'should';
import {
  type ActivityTimerHost,
  AsyncActivityScope,
  afterAsActivity,
  asActivity,
} from '../../../src/adapters/runtime/index.ts';
import { BoardService } from '../../../src/lib/board/index.ts';
import { GitHubWatcher, type GitHubWatcherPorts } from '../../../src/lib/board-github/index.ts';
import { ActivityLedger } from '../../../src/lib/runtime/liveness.ts';
import { world } from '../board/support.ts';

const WATCH = 'board github watch';

/**
 * Timers on a hand-moved clock that, like the runtime's own, remember the asynchronous context they were
 * ARMED in and run their callback inside it.
 */
class ContextTimers implements ActivityTimerHost {
  private next = 1;
  private readonly armed = new Map<number, { readonly at: number; readonly callback: () => void }>();
  now = 0;

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next;
    this.next += 1;
    this.armed.set(handle, { at: this.now + ms, callback: AsyncResource.bind(callback) });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.armed.delete(handle as number);
  }

  get pending(): number {
    return this.armed.size;
  }

  /** Fires the earliest armed timer. */
  fireNext(): void {
    const due = [...this.armed.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
    if (due === undefined) throw new Error('no timer armed');
    this.now = due[1].at;
    this.armed.delete(due[0]);
    due[1].callback();
  }
}

const ledger = (): ActivityLedger => new ActivityLedger({ now: () => 0 }, new AsyncActivityScope());

describe('afterAsActivity', () => {
  it('should run a board github watch tick as the top-level activity every time, however many ticks came before', async () => {
    // Arrange
    const activities = ledger();
    const host = new ContextTimers();
    const seen: (string | undefined)[] = [];
    const finished: Promise<void>[] = [];
    const ports: GitHubWatcherPorts = {
      board: {
        snapshot: async () => {
          seen.push(activities.current());
          return await new BoardService(world()).snapshot();
        },
        recordPullRequests: async () => Promise.reject(new Error('no cards to write')),
        act: async () => Promise.reject(new Error('no cards to act on')),
      },
      gh: { run: async () => ({ kind: 'ok', stdout: '' }) },
      copies: { repositoryOf: async () => null, branchOf: async () => null },
      sessions: { cwdOf: async () => null },
      projects: { projects: async () => [] },
      transcripts: { tail: async () => ({ kind: 'unresolved' }) },
      nudges: { send: async () => undefined },
      timers: {
        after: (ms, run) =>
          afterAsActivity(
            activities,
            WATCH,
            () => {
              const tick = run();
              finished.push(tick);
              return tick;
            },
            ms,
            { host },
          ),
      },
      clock: { now: () => new Date(0).toISOString(), random: () => 0.5 },
      diagnostics: { warn: () => undefined },
      unfiled: { run: async () => [] },
      version: '0.0.0',
    };
    const stop = new GitHubWatcher(ports).arm();

    // Act — five ticks, each armed from inside the one before.
    for (let tick = 0; tick < 5; tick += 1) {
      host.fireNext();
      await Promise.all(finished);
    }
    stop();

    // Assert
    should(seen).deepEqual([WATCH, WATCH, WATCH, WATCH, WATCH]);
    should(host.pending).equal(0);
  });

  it('should show the nesting a timer armed inside the tick would have, so the case above proves something', async () => {
    // Arrange
    const activities = ledger();
    const host = new ContextTimers();
    const seen: (string | undefined)[] = [];
    const schedule = (): void => {
      host.setTimeout(
        asActivity(activities, WATCH, () => {
          seen.push(activities.current());
          if (seen.length < 3) schedule();
        }),
        1,
      );
    };
    schedule();

    // Act
    for (let tick = 0; tick < 3; tick += 1) {
      host.fireNext();
    }

    // Assert
    should(seen).deepEqual([WATCH, `${WATCH} › ${WATCH}`, `${WATCH} › ${WATCH} › ${WATCH}`]);
  });

  it('should cancel the timer it armed, and run the work as a plain call where there is no ledger', async () => {
    // Arrange
    const host = new ContextTimers();
    const ran: string[] = [];

    // Act
    const cancel = afterAsActivity(undefined, WATCH, () => ran.push('cancelled'), 1, { host });
    cancel();
    afterAsActivity(undefined, WATCH, () => ran.push('ran'), 1, { host });
    host.fireNext();

    // Assert
    should(ran).deepEqual(['ran']);
    should(host.pending).equal(0);
  });
});
