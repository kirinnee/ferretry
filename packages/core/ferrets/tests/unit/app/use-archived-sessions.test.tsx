import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  ARCHIVED_COUNT_POLL_MS,
  ARCHIVED_SESSIONS_LIMIT,
  type ArchivedSessionsClient,
  type ArchivedSessionsEnvironment,
  browserArchivedSessionsEnvironment,
  useArchivedSessions,
} from '../../../app/hooks/use-archived-sessions.ts';
import { type DaemonConnection, daemonConnection } from '../../../app/lib/daemon-connection.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.invalid', deviceId: 'alpha-device' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.invalid', deviceId: 'beta-device' });

const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 2, 9, minutes)).toISOString();
const archivedView = (id: string, endedAt: string): SessionView =>
  sessionView(id, {
    config: { name: `Old work ${id}`, cwd: '/work/old', mode: 'auto' },
    state: { status: 'completed', startedAt: at(0), finishedAt: endedAt },
  });

/** One archive's answer: the count every read carries, and the rows a Show asked for. */
interface Reply {
  readonly count: number;
  readonly sessions?: SessionView[];
}

/**
 * A client double that records every read's limit. `replies` is a queue — each read shifts the next,
 * and an empty queue repeats the last — so a test can script a good answer, then a fault, then a
 * recovery without rebuilding the client.
 */
const fakeClient = () => {
  const reads: number[] = [];
  const replies: (Reply | Error)[] = [{ count: 0 }];
  const client: ArchivedSessionsClient = {
    archivedSessions: async (limit = ARCHIVED_SESSIONS_LIMIT) => {
      reads.push(limit);
      const next = replies.length > 1 ? replies.shift() : replies.at(0);
      if (next === undefined) throw new Error('no reply scripted');
      if (next instanceof Error) throw next;
      return { count: next.count, sessions: next.sessions ?? [] };
    },
  };
  return {
    reads,
    replyWith: (...queue: (Reply | Error)[]) => {
      replies.length = 0;
      replies.push(...queue);
    },
    clientFor: async (_daemon: DaemonConnection) => client,
  };
};

/** Timers and visibility a test drives by hand, in the shape `use-machines-poll.ts` taught. */
const fakeEnvironment = () => {
  let visible = true;
  const ticks: (() => void)[] = [];
  const intervals: number[] = [];
  let shown: (() => void) | undefined;
  const environment: ArchivedSessionsEnvironment = {
    visible: () => visible,
    setInterval: (callback, milliseconds) => {
      intervals.push(milliseconds);
      ticks.push(callback);
      return ticks.length;
    },
    clearInterval: () => undefined,
    onVisibility: listener => {
      shown = listener;
      return () => undefined;
    },
  };
  return {
    environment,
    intervals,
    tick: (): void => {
      for (const fire of [...ticks]) fire();
    },
    hide: (): void => {
      visible = false;
    },
    show: (): void => {
      visible = true;
      shown?.();
    },
  };
};

/** What the hook holds, as one string a probe can print. */
const stateOf = (view: Mounted): string =>
  must(view.container.querySelector('[data-state]'), 'the hook state').textContent ?? '';

function Probe({
  daemon,
  clientFor,
  environment,
}: {
  readonly daemon: DaemonConnection;
  readonly clientFor: (daemon: DaemonConnection) => Promise<ArchivedSessionsClient>;
  readonly environment: ArchivedSessionsEnvironment;
}) {
  const archived = useArchivedSessions(daemon, clientFor, environment);
  return (
    <div>
      <output data-state="">
        {JSON.stringify({
          count: archived.count,
          sessions: archived.sessions === null ? null : archived.sessions.map(view => view.config.id),
          shown: archived.shown,
          loading: archived.loading,
        })}
      </output>
      <button data-act="show" onClick={archived.onShow} type="button">
        show
      </button>
      <button data-act="hide" onClick={archived.onHide} type="button">
        hide
      </button>
    </div>
  );
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** Flushes the microtasks a read and its publish wait behind. */
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  });
};

const press = async (view: Mounted, which: 'show' | 'hide'): Promise<void> => {
  await interact(() =>
    (must(view.container.querySelector(`[data-act="${which}"]`), `the ${which} control`) as HTMLElement).click(),
  );
};

describe('useArchivedSessions', () => {
  test('asks only the count on mount, and again on each sixty-second beat', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 3 });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    const first = stateOf(view);
    timers.tick();
    await settle();

    // Assert
    expect(first).toBe('{"count":3,"sessions":null,"shown":false,"loading":false}');
    expect(stateOf(view)).toBe(first);
    expect(machine.reads).toEqual([0, 0]);
    expect(timers.intervals).toEqual([ARCHIVED_COUNT_POLL_MS]);
  });

  test('a 404 says the daemon does not serve the route: no count, and the beat stops asking', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith(new FyHttpError('route absent', 404, 'not_found'));
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    timers.tick();
    timers.tick();
    await settle();

    // Assert
    expect(stateOf(view)).toBe('{"count":null,"sessions":null,"shown":false,"loading":false}');
    expect(machine.reads).toEqual([0]);
  });

  test('a transient fault keeps the last count; the next beat asks again', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 5 }, new Error('relay dropped'), { count: 5 });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    timers.tick();
    await settle();
    timers.tick();
    await settle();

    // Assert
    expect(stateOf(view)).toBe('{"count":5,"sessions":null,"shown":false,"loading":false}');
    expect(machine.reads).toEqual([0, 0, 0]);
  });

  test('reads nothing while the tab is hidden, and one read is owed when it is shown', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 2 });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    timers.hide();
    timers.tick();
    await settle();
    timers.show();
    await settle();

    // Assert
    expect(machine.reads).toEqual([0, 0]);
  });

  test('Show lists the newest hundred once; a Hide and Show again reads nothing more', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 2, sessions: [archivedView('arch-old', at(5)), archivedView('arch-new', at(30))] });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    await press(view, 'show');
    await settle();
    await press(view, 'hide');
    await press(view, 'show');
    await settle();

    // Assert — the rows are held as the route answered them; the footer orders them (sessions-bar-archived.ts).
    expect(stateOf(view)).toBe('{"count":2,"sessions":["arch-old","arch-new"],"shown":true,"loading":false}');
    expect(machine.reads).toEqual([0, ARCHIVED_SESSIONS_LIMIT]);
  });

  test('a Show after the count moved reads the rows again', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 2, sessions: [archivedView('arch-old', at(5))] });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    await press(view, 'show');
    await settle();
    await press(view, 'hide');
    machine.replyWith({ count: 3, sessions: [archivedView('arch-old', at(5)), archivedView('arch-new', at(30))] });
    timers.tick();
    await settle();
    await press(view, 'show');
    await settle();

    // Assert
    expect(stateOf(view)).toBe('{"count":3,"sessions":["arch-old","arch-new"],"shown":true,"loading":false}');
    expect(machine.reads).toEqual([0, ARCHIVED_SESSIONS_LIMIT, 0, ARCHIVED_SESSIONS_LIMIT]);
  });

  test('switching machines starts from unread, and the other machine’s late answer is dropped', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 7 }, { count: 4 });
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await view.render(<Probe daemon={beta} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();

    // Assert — whatever order the two reads settle in, alpha's 7 is dropped and only beta's own 4 lands.
    expect(stateOf(view)).toBe('{"count":4,"sessions":null,"shown":false,"loading":false}');
    expect(machine.reads).toEqual([0, 0]);
  });

  test('a Show whose read fails stops waiting and leaves the rows unread', async () => {
    // Arrange
    const machine = fakeClient();
    machine.replyWith({ count: 2 }, new Error('relay dropped mid-read'));
    const timers = fakeEnvironment();

    // Act
    view = await mount(<Probe daemon={alpha} clientFor={machine.clientFor} environment={timers.environment} />);
    await settle();
    await press(view, 'show');
    await settle();

    // Assert — the count the footer words survives; the reader may press Show again.
    expect(stateOf(view)).toBe('{"count":2,"sessions":null,"shown":true,"loading":false}');
    expect(machine.reads).toEqual([0, ARCHIVED_SESSIONS_LIMIT]);
  });

  test('the browser environment it runs on answers the seams it names', () => {
    // Arrange — the document the dom support mounts into, with no page visibility of its own.
    let seen = 0;
    let fired = 0;

    // Act
    const release = browserArchivedSessionsEnvironment.onVisibility(() => (seen += 1));
    document.dispatchEvent(new Event('visibilitychange'));
    release();
    document.dispatchEvent(new Event('visibilitychange'));
    const handle = browserArchivedSessionsEnvironment.setInterval(() => (fired += 1), ARCHIVED_COUNT_POLL_MS);
    browserArchivedSessionsEnvironment.clearInterval(handle);

    // Assert
    expect(seen).toBe(1);
    expect(fired).toBe(0);
    expect(browserArchivedSessionsEnvironment.visible()).toBe(document.visibilityState !== 'hidden');
  });
});
