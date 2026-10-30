import { afterEach, describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { useBoardAsks } from '../../src/hooks/use-board-asks.ts';
import type { SessionAgenda } from '../../src/lib/board-detail.ts';
import type { DaemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonAgendaStore } from '../../src/lib/agenda-store.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { flush, laptop, workstation } from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const snapshotOf = (sessionId: string) => ({
  v: 1,
  sessionId,
  items: [],
  resolved: [],
  count: 0,
  parseErrors: 0,
  updatedAt: '2026-07-31T00:00:00.000Z',
});

const open = (hydrate: (machine: DaemonConnection, sessionId: string) => Promise<void> = async () => undefined) => {
  const store = new DaemonAgendaStore();
  const hydrated: string[] = [];
  const agenda = {
    store,
    hydrate: async (machine: DaemonConnection, scope: { sessionId: string }) => {
      hydrated.push(`${machine.daemonId}:${scope.sessionId}`);
      await hydrate(machine, scope.sessionId);
    },
  };
  return { store, agenda: agenda as never, hydrated };
};

interface Seen {
  agendas?: readonly SessionAgenda[];
}

function Probe({
  seen,
  agenda,
  machine,
  sessions,
}: {
  readonly seen: Seen;
  readonly agenda: Parameters<typeof useBoardAsks>[0];
  readonly machine: DaemonConnection | undefined;
  readonly sessions: readonly string[];
}) {
  seen.agendas = useBoardAsks(agenda, machine, sessions);
  return null;
}

describe('useBoardAsks', () => {
  test('reads each session’s agenda once and has none to show until it arrives', async () => {
    const { agenda, hydrated } = open();
    const seen: Seen = {};
    view = await mount(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1', 's2']} />);
    await flush();
    expect(hydrated).toEqual([`${laptop.daemonId}:s1`, `${laptop.daemonId}:s2`]);
    expect(seen.agendas).toEqual([
      { sessionId: 's1', snapshot: null },
      { sessionId: 's2', snapshot: null },
    ]);
  });

  test('shows a snapshot as soon as the store holds it, and follows later ones', async () => {
    const { agenda, store } = open();
    const seen: Seen = {};
    view = await mount(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1', 's2']} />);
    await interact(() => store.applySnapshot(daemonSessionScope(laptop, 's1'), snapshotOf('s1')));
    expect(seen.agendas?.map(entry => [entry.sessionId, entry.snapshot?.sessionId ?? null])).toEqual([
      ['s1', 's1'],
      ['s2', null],
    ]);
    await interact(() => store.applySnapshot(daemonSessionScope(laptop, 's2'), snapshotOf('s2')));
    expect(seen.agendas?.every(entry => entry.snapshot !== null)).toBe(true);
  });

  test('reads a new session when the list changes, and nothing again when it does not', async () => {
    const { agenda, hydrated } = open();
    const seen: Seen = {};
    view = await mount(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1']} />);
    await view.render(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1']} />);
    expect(hydrated).toEqual([`${laptop.daemonId}:s1`]);
    await view.render(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1', 's2']} />);
    expect(hydrated).toEqual([`${laptop.daemonId}:s1`, `${laptop.daemonId}:s1`, `${laptop.daemonId}:s2`]);
  });

  test('reads again from another machine and shows what that machine holds', async () => {
    const { agenda, hydrated, store } = open();
    const seen: Seen = {};
    store.applySnapshot(daemonSessionScope(laptop, 's1'), snapshotOf('s1'));
    view = await mount(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1']} />);
    expect(seen.agendas?.[0]?.snapshot).not.toBeNull();
    await view.render(<Probe agenda={agenda} machine={workstation} seen={seen} sessions={['s1']} />);
    expect(hydrated).toEqual([`${laptop.daemonId}:s1`, `${workstation.daemonId}:s1`]);
    expect(seen.agendas?.[0]?.snapshot).toBeNull();
  });

  test('reads nothing and shows nothing without a machine', async () => {
    const { agenda, hydrated, store } = open();
    const seen: Seen = {};
    store.applySnapshot(daemonSessionScope(laptop, 's1'), snapshotOf('s1'));
    view = await mount(<Probe agenda={agenda} machine={undefined} seen={seen} sessions={['s1']} />);
    await flush();
    expect(hydrated).toEqual([]);
    expect(seen.agendas).toEqual([{ sessionId: 's1', snapshot: null }]);
  });

  test('keeps going when a read fails', async () => {
    const { agenda, hydrated } = open(async () => {
      throw new Error('offline');
    });
    const seen: Seen = {};
    view = await mount(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1', 's2']} />);
    await flush();
    expect(hydrated).toHaveLength(2);
    expect(seen.agendas).toHaveLength(2);
  });

  test('a server render reads the store as it is', () => {
    const { agenda, store } = open();
    store.applySnapshot(daemonSessionScope(laptop, 's1'), snapshotOf('s1'));
    const seen: Seen = {};
    renderToString(<Probe agenda={agenda} machine={laptop} seen={seen} sessions={['s1']} />);
    expect(seen.agendas?.[0]?.snapshot?.sessionId).toBe('s1');
  });
});
