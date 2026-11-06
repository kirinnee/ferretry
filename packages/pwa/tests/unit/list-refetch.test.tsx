import { afterEach, describe, expect, it } from 'bun:test';
import { type FyEvent, MACHINE_AGENDA_ID, type SessionView } from '@ferretry/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import { useAgendaInboxModel } from '../../src/hooks/use-agenda-inbox.ts';
import {
  useMachinesPoll,
  type FleetPollEnvironment,
  type MachineFleetFeedOpener,
} from '../../src/hooks/use-machines-poll.ts';
import { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { listClock, listDeferred } from '../support/list-refresh.ts';
import { interact, mount, type Mounted } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';
import { settleUntil } from '../support/settle.ts';

const machine = daemonConnection({ daemonId: 'machine', baseUrl: 'https://machine.invalid', deviceId: 'device' });
const machines = [machine];
const scope = daemonSessionScope(machine, MACHINE_AGENDA_ID);
const event = (type: string, sessionId = 's'): FyEvent => ({
  sequence: 1,
  time: '2026-11-01T00:00:00.000Z',
  source: 'daemon',
  sessionId,
  type,
  data: {},
});
const board = (count = 0) => ({
  v: 1,
  sessionId: MACHINE_AGENDA_ID,
  items: Array.from({ length: count }, (_, index) => ({
    id: `A${index + 1}`,
    source: 'question',
    sourceRef: null,
    subject: 'Choose',
    why: 'Decision needed',
    waitingSince: '2026-11-01T00:00:00.000Z',
    howToResolve: 'Reply',
    raisedBy: 'human',
    raisedBySession: null,
    raisedByName: null,
  })),
  resolved: [],
  count,
  parseErrors: 0,
  updatedAt: '2026-11-01T00:00:00.000Z',
});
let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const setup = () => {
  const clock = listClock();
  let visible = true;
  let visibility: (() => void) | undefined;
  let sessions = [sessionView('s')];
  let agendaValue = board(1);
  const reads = { sessions: 0, agenda: 0, writes: 0 };
  const ticks = new Map<number, () => void>();
  const environment: FleetPollEnvironment = {
    visible: () => visible,
    now: clock.environment.now,
    onVisibility: callback => {
      visibility = callback;
      return () => {
        visibility = undefined;
      };
    },
    setInterval: (callback, ms) => {
      ticks.set(ms, callback);
      return ms;
    },
    clearInterval: handle => {
      ticks.delete(handle as number);
    },
  };
  const fleet = new DaemonFleetStore(
    {
      list: async () => {
        reads.sessions += 1;
        return sessions;
      },
      get: async () => sessionView('s'),
    },
    clock.environment.now,
    { schedule: clock.environment.schedule },
  );
  const agenda = new DaemonAgendaClient(
    undefined,
    async (input, init) => {
      // The roll-up is its own read; this test counts reads of the machine board.
      if (String(input).includes('/v1/agenda/open')) return new Response('{}', { status: 404 });
      if (init?.method === 'POST') {
        reads.writes += 1;
        agendaValue = board();
      } else reads.agenda += 1;
      return Response.json(agendaValue);
    },
    undefined,
    clock.environment,
  );
  const streams: { event: (event: FyEvent) => void; idle: () => void; end: () => void }[] = [];
  const open: MachineFleetFeedOpener = (_machine, onEvent, onIdle, signal) =>
    new Promise(resolve => {
      streams.push({ event: onEvent, idle: () => onIdle(60), end: resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const feedEnvironment = {
    ...clock.environment,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
  };
  return {
    clock,
    reads,
    fleet,
    agenda,
    streams,
    stream: (index = 0) => {
      const stream = streams[index];
      if (stream === undefined) throw new Error('Feed not opened');
      return stream;
    },
    open,
    environment,
    feedEnvironment,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
      visibility?.();
    },
    tick: () => {
      for (const run of ticks.values()) run();
    },
    sessions: (value: SessionView[]) => {
      sessions = value;
    },
  };
};
type Subject = ReturnType<typeof setup>;
/** Response.json() may finish on a real task; wait for the published board, not a microtask budget. */
const settleLists = async (subject: Subject, previous?: ReturnType<Subject['agenda']['store']['agenda']>) => {
  await settleUntil(
    () =>
      subject.fleet.fleet(machine.daemonId).status === 'ready' &&
      subject.agenda.store.status(scope) === 'ready' &&
      subject.agenda.store.agenda(scope) !== previous,
    'session list and fresh machine agenda published',
    interact,
  );
  return subject.agenda.store.agenda(scope);
};
function Poller({ subject }: { subject: Subject }) {
  useMachinesPoll(
    subject.fleet,
    machines,
    machine.daemonId,
    false,
    subject.environment,
    subject.open,
    subject.feedEnvironment,
    undefined,
    subject.agenda,
  );
  return null;
}
function Reader({ subject }: { subject: Subject }) {
  useEffect(() => {
    void subject.fleet.ensure(machine);
    void subject.agenda.hydrate(machine, scope);
    void subject.agenda.hydrateCount(machine, scope);
  }, [subject]);
  const snapshot = useSyncExternalStore(subject.fleet.subscribe, subject.fleet.getSnapshot);
  const agendaSnapshot = useSyncExternalStore(
    listener => subject.agenda.store.subscribe(listener),
    () => subject.agenda.store.getSnapshot(),
  );
  return (
    <span>
      {snapshot.daemons.get(machine.daemonId)?.sessions?.[0]?.state.status}:
      {agendaSnapshot.counts.get(daemonSessionKey(scope))}
    </span>
  );
}

describe('shared whole-list traffic', () => {
  it('reads through republished connection facts when a queued request starts', async () => {
    // Arrange
    const clock = listClock();
    const calls: unknown[] = [];
    const subject = new DaemonFleetStore(
      {
        list: async connection => {
          calls.push(connection);
          return [];
        },
        get: async () => sessionView('s'),
      },
      clock.environment.now,
      { schedule: clock.environment.schedule },
    );
    await subject.ensure(machine);
    const updated = daemonConnection({
      daemonId: machine.daemonId,
      baseUrl: machine.baseUrl,
      deviceId: machine.deviceId,
      daemonName: 'Republished',
    });
    // Act
    const queued = subject.hydrate(machine);
    await subject.ensure(updated);
    await clock.advance(10_000);
    await queued;
    // Assert
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(updated);
  });

  it('N mounted components and badge readers share one fetch, including later mounts', async () => {
    // Arrange
    const subject = setup();
    // Act
    const readers = Array.from({ length: 20 }, (_, index) => ({ id: `reader-${index}` }));
    view = await mount(
      <div>
        {readers.slice(0, 10).map(reader => (
          <Reader key={reader.id} subject={subject} />
        ))}
      </div>,
    );
    await settleLists(subject);
    await view.render(
      <div>
        {readers.map(reader => (
          <Reader key={reader.id} subject={subject} />
        ))}
      </div>,
    );
    // Assert
    expect(subject.reads).toEqual({ sessions: 1, agenda: 1, writes: 0 });
    expect([...view.container.querySelectorAll('span')].map(reader => reader.textContent)).toEqual(
      Array.from({ length: 20 }, () => 'running:1'),
    );
    await subject.clock.advance(10_000);
    expect(subject.reads.sessions).toBe(1);
    expect(subject.reads.agenda).toBe(1);
  });

  it('50 relevant events in 10 seconds fetch each list at most twice; unrelated events fetch neither', async () => {
    // Arrange
    const subject = setup();
    view = await mount(<Poller subject={subject} />);
    subject.stream().idle();
    const previous = await settleLists(subject);
    // Act
    for (let index = 0; index < 50; index += 1) {
      subject.stream().event(event('turn.state'));
      subject.stream().event(event('agenda.changed', MACHINE_AGENDA_ID));
      await subject.clock.advance(200);
    }
    await settleLists(subject, previous);
    // Assert
    expect(subject.reads.sessions).toBe(2);
    expect(subject.reads.agenda).toBe(2);
    // Assert final counts after draining every pending burst invalidation.
    await subject.clock.advance(10_000);
    expect(subject.reads).toEqual({ sessions: 2, agenda: 2, writes: 0 });
    const before = { ...subject.reads };
    for (const type of [
      'surface.driving',
      'surface.opened',
      'surface.asked',
      'surface.takeover',
      'surface.handback',
      'surface.handed',
    ])
      subject.stream().event(event(type));
    await subject.clock.advance(10_000);
    expect(subject.reads).toEqual(before);
  });

  it('applies the own-action result promptly while old reads and cooldowns are outstanding', async () => {
    // Arrange
    const subject = setup();
    await subject.fleet.ensure(machine);
    await subject.agenda.hydrate(machine, scope);
    view = await mount(<Reader subject={subject} />);
    const refresh = subject.agenda.revalidate(machine, scope);
    subject.fleet.hydrate(machine);
    // Act
    await interact(async () => {
      subject.fleet.upsertSession(machine.daemonId, sessionView('s', { state: { status: 'stopped' } }));
      await subject.agenda.dismiss(machine, scope, 'A1');
    });
    // Assert: no clock advance and no extra GET for either action.
    expect(subject.fleet.session(daemonSessionScope(machine, 's'))?.state.status).toBe('stopped');
    expect(subject.agenda.store.count(scope)).toBe(0);
    expect(view.container.textContent).toBe('stopped:0');
    expect(subject.reads).toEqual({ sessions: 1, agenda: 1, writes: 1 });
    await subject.clock.advance(10_000);
    await refresh;
  });

  it('reconnect reconciles each list once, even when the reconnect is inside the cooldown', async () => {
    // Arrange
    const subject = setup();
    view = await mount(<Poller subject={subject} />);
    subject.stream().idle();
    const previous = await settleLists(subject);
    // Act
    subject.stream().end();
    await interact(() => unitClock.turn());
    await subject.clock.advance(1_000);
    subject.stream(1).idle();
    await subject.clock.advance(9_000);
    await settleLists(subject, previous);
    // Assert
    expect(subject.reads.sessions).toBe(2);
    expect(subject.reads.agenda).toBe(2);
    await subject.clock.advance(10_000);
    expect(subject.reads.sessions).toBe(2);
    expect(subject.reads.agenda).toBe(2);
  });

  it('uses only the slow safety beat while down, and skips live-busy and hidden lists', async () => {
    // Arrange
    const subject = setup();
    view = await mount(<Poller subject={subject} />);
    subject.stream().idle();
    let previous = await settleLists(subject);
    // Act: a live, recently read list has no safety traffic.
    subject.tick();
    await interact(() => unitClock.turn());
    expect(subject.reads.sessions).toBe(1);
    expect(subject.reads.agenda).toBe(1);
    for (let index = 0; index < 5; index += 1) {
      subject.stream().idle();
      await subject.clock.advance(60_000);
    }
    subject.tick();
    previous = await settleLists(subject, previous);
    expect(subject.reads.sessions).toBe(2);
    expect(subject.reads.agenda).toBe(2);
    subject.stream().end();
    await interact(() => unitClock.turn());
    await subject.clock.advance(60_000);
    subject.tick();
    previous = await settleLists(subject, previous);
    expect(subject.reads.sessions).toBe(3);
    expect(subject.reads.agenda).toBe(3);
    // Assert: hidden safety beats do nothing; returning reconciles once through the same budget.
    subject.hide();
    await subject.clock.advance(60_000);
    subject.tick();
    expect(subject.reads.sessions).toBe(3);
    expect(subject.reads.agenda).toBe(3);
    subject.show();
    await settleLists(subject, previous);
    expect(subject.reads.sessions).toBe(4);
    expect(subject.reads.agenda).toBe(4);
  });

  it('keeps one network read in flight even after a caller deadline and publishes a late answer', async () => {
    // Arrange
    const clock = listClock();
    const pending = listDeferred<readonly SessionView[]>();
    let reads = 0;
    const subject = new DaemonFleetStore(
      {
        list: () => {
          reads += 1;
          return pending.promise;
        },
        get: async () => sessionView('s'),
      },
      clock.environment.now,
      { schedule: clock.environment.schedule },
    );
    const first = subject.hydrate(machine).catch(() => undefined);
    // Act
    await clock.advance(15_000);
    await first;
    const next = subject.hydrate(machine);
    expect(reads).toBe(1);
    pending.resolve([sessionView('s')]);
    await next;
    // Assert
    expect(subject.fleet(machine.daemonId).status).toBe('ready');
    expect(reads).toBe(1);
  });

  it('clears queued reads on re-pair, without publishing data from the former connection', async () => {
    // Arrange
    const subject = setup();
    await subject.fleet.ensure(machine);
    await subject.agenda.hydrate(machine, scope);
    const queuedFleet = subject.fleet.hydrate(machine);
    const queuedAgenda = subject.agenda.revalidate(machine, scope);
    const moved = daemonConnection({
      daemonId: machine.daemonId,
      baseUrl: 'https://moved.invalid',
      deviceId: 'new-device',
    });
    // Act
    await subject.fleet.ensure(moved);
    await subject.agenda.hydrate(moved, scope);
    // Assert
    await expect(queuedFleet).rejects.toThrow('cleared');
    await expect(queuedAgenda).rejects.toThrow('cleared');
    await subject.clock.advance(10_000);
    expect(subject.reads.sessions).toBe(2);
    expect(subject.reads.agenda).toBe(2);
    subject.agenda.clearDaemon(machine.daemonId);
    expect(subject.agenda.store.status(scope)).toBe('idle');
  });

  it('routes only agenda events to boards, including a previously unread machine ledger', async () => {
    // Arrange
    const subject = setup();
    // Act
    subject.agenda.noteEvent(machine, event('output.delta', MACHINE_AGENDA_ID));
    subject.agenda.noteEvent(machine, event('agenda.changed', 'unread-session'));
    expect(subject.reads.agenda).toBe(0);
    subject.agenda.noteEvent(machine, event('attention.changed', MACHINE_AGENDA_ID));
    await subject.agenda.hydrate(machine, scope);
    expect(subject.reads.agenda).toBe(1);
    let reads = 0;
    const sessionClient = new DaemonAgendaClient(undefined, async () => {
      reads += 1;
      return Response.json({ ...board(), sessionId: 's' });
    });
    await sessionClient.hydrate(machine, daemonSessionScope(machine, 's'));
    const previous = sessionClient.store.agenda(daemonSessionScope(machine, 's'));
    sessionClient.noteEvent(machine, event('agenda.changed'));
    await settleUntil(
      () => sessionClient.store.agenda(daemonSessionScope(machine, 's')) !== previous,
      'refreshed session board published',
      interact,
    );
    // Assert
    expect(reads).toBe(2);
    expect(() =>
      subject.agenda.hydrate(
        daemonConnection({ daemonId: 'other', baseUrl: 'https://other.invalid', deviceId: 'other' }),
        scope,
      ),
    ).toThrow('scope');
  });
});
const inboxMachines = [{ connection: machine, name: 'Machine', sessions: [] }];
function RealInbox({ subject }: { subject: Subject }) {
  const inbox = useAgendaInboxModel(subject.agenda, inboxMachines, {
    now: subject.clock.environment.now,
    setTimeout: subject.clock.setTimeout,
    clearTimeout: subject.clock.clearTimeout,
  });
  return <span>{inbox.total}</span>;
}

describe('shared list freshness regressions', () => {
  it.each(['interaction.help', 'session.resumed', 'turn.prompt', 'control.send_accepted', 'new.state-event'])(
    'refreshes %s status within 10 seconds',
    async type => {
      const subject = setup();
      view = await mount(<Poller subject={subject} />);
      subject.stream().idle();
      await settleLists(subject);
      subject.sessions([sessionView('s', { state: { status: 'waiting' } })]);
      subject.stream().event(event(type));
      await subject.clock.advance(10_000);
      expect(subject.fleet.session(daemonSessionScope(machine, 's'))?.state.status).toBe('waiting');
    },
  );

  it('does not refetch an already held machine board merely to render the real Inbox', async () => {
    const subject = setup();
    view = await mount(
      <>
        <Poller subject={subject} />
        <RealInbox subject={subject} />
      </>,
    );
    subject.stream().idle();
    await settleLists(subject);
    expect(subject.reads.agenda).toBe(1);
    await interact(async () => {
      await subject.clock.advance(10_000);
    });
    expect(subject.reads.agenda).toBe(1);
  });

  it('refreshes a dirty machine list within 10 seconds even when the opening response takes 5 seconds', async () => {
    const clock = listClock();
    const pending = listDeferred<readonly SessionView[]>();
    let reads = 0;
    const fleet = new DaemonFleetStore(
      {
        list: () =>
          ++reads === 1 ? pending.promise : Promise.resolve([sessionView('s', { state: { status: 'waiting' } })]),
        get: async () => sessionView('s'),
      },
      clock.environment.now,
      { schedule: clock.environment.schedule },
    );
    const first = fleet.ensure(machine);
    await clock.advance(1_000);
    fleet.invalidate(machine);
    await clock.advance(4_000);
    pending.resolve([sessionView('s')]);
    await first;
    await clock.advance(6_000);
    expect(fleet.session(daemonSessionScope(machine, 's'))?.state.status).toBe('waiting');
  });

  it('refreshes a session auto-title and focus changed by a board write', async () => {
    // Arrange: BoardService.afterWrite updates both fields through StorageSessionFocus.
    const subject = setup();
    view = await mount(<Poller subject={subject} />);
    subject.stream().idle();
    await settleLists(subject);
    const updated = sessionView('s', {
      config: { name: 'Updated task title', nameSource: 'auto', focusTask: { id: 'F123' } },
    });
    // Act
    subject.sessions([updated]);
    subject.stream().event(event('board.changed'));
    await subject.clock.advance(10_000);
    // Assert
    expect(subject.fleet.session(daemonSessionScope(machine, 's'))?.config.name).toBe('Updated task title');
    expect(subject.fleet.session(daemonSessionScope(machine, 's'))?.config.focusTask).toEqual({ id: 'F123' });
    expect(subject.reads.sessions).toBe(2);
  });
});
