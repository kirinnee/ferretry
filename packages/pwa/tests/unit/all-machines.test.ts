import { describe, expect, test } from 'bun:test';
import {
  allMachinesView,
  type ListReach,
  type MachineSource,
  machineDisplayOrder,
  machineReach,
  machineReachLabel,
  needsYouUrgency,
  shortAge,
  waitingSince,
} from '../../src/lib/all-machines.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonFleetSlice } from '../../src/lib/fleet-store.ts';
import { sessionView } from '../support/sessions.ts';

const STUDIO = 'studio' as DaemonId;
const LAPTOP = 'laptop' as DaemonId;
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 18, 12, minutes)).toISOString();

const open = (minutes: number) => ({ open: 1, first: 'A1', ask: 'Ask?', latestAt: at(minutes) });

const slice = (sessions: DaemonFleetSlice['sessions'], patch: Partial<DaemonFleetSlice> = {}): DaemonFleetSlice => ({
  sessions,
  byId: new Map(),
  status: sessions === null ? 'idle' : 'ready',
  error: null,
  ...patch,
});

const machine = (
  daemonId: DaemonId,
  sessions: DaemonFleetSlice['sessions'],
  reach: ListReach = 'online',
  patch: Partial<DaemonFleetSlice> = {},
): MachineSource => ({
  daemonId,
  name: String(daemonId),
  slice: slice(sessions, patch),
  projects: [{ name: 'ferretry', path: '/work/ferretry' }],
  reach,
});

const question = sessionView('q', {
  config: { cwd: '/work/ferretry' },
  state: { status: 'awaiting_question', turnStateAt: at(5), attention: open(5) },
});
const human = sessionView('h', {
  config: { cwd: '/work/ferretry' },
  state: { needsHuman: 'stuck', turnStateAt: at(1), attention: open(1) },
});
const you = sessionView('y', {
  config: { cwd: '/work/notes' },
  state: { status: 'awaiting_user', turnStateAt: at(0), attention: open(0) },
});
const busy = sessionView('b', { config: { cwd: '/work/ferretry' } });

describe('machineReach', () => {
  test('says locked, offline, reading and online from the health fact and the list read', () => {
    expect(machineReach({ kind: 'connected' }, slice([]), true)).toBe('locked');
    expect(
      machineReach(
        {
          kind: 'reconnecting',
          since: 0,
          attempt: 1,
          nextAttemptAt: null,
          failures: [],
          cause: 'unknown',
          stalled: false,
        },
        slice([]),
        false,
      ),
    ).toBe('offline');
    expect(machineReach({ kind: 'connected' }, slice([], { status: 'error', error: 'no' }), false)).toBe('offline');
    expect(machineReach({ kind: 'unknown' }, slice(null), false)).toBe('reading');
    expect(machineReach({ kind: 'unknown' }, slice([]), false)).toBe('online');
  });
});

describe('needs-you order', () => {
  test('a question or a prompt first, then a human flag, then plain waiting', () => {
    expect(needsYouUrgency(question)).toBe(0);
    expect(needsYouUrgency(sessionView('p', { state: { pendingQuestion: { id: 'x' } as never } }))).toBe(0);
    expect(needsYouUrgency(sessionView('n', { state: { turnState: 'needs-input' } }))).toBe(0);
    expect(needsYouUrgency(human)).toBe(1);
    expect(needsYouUrgency(you)).toBe(2);
  });

  test('waits since the turn change, else the last activity, else the config, and never NaN', () => {
    expect(waitingSince(question)).toBe(Date.parse(at(5)));
    const activity = sessionView('a', { state: { lastActivityAt: at(7) } });
    expect(waitingSince(activity)).toBe(Date.parse(at(7)));
    const bare = sessionView('c', { state: { lastActivityAt: undefined as never } });
    expect(waitingSince(bare)).toBe(Date.parse('1970-01-01T00:00:01.000Z'));
    const broken = sessionView('d', { state: { turnStateAt: 'not a time' } });
    expect(waitingSince(broken)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('allMachinesView', () => {
  test('pins every reachable machine’s waiting sessions, most urgent and oldest first, and moves them up', () => {
    const view = allMachinesView([machine(STUDIO, [busy, human, you]), machine(LAPTOP, [question])]);
    expect(view.needsYou.map(entry => [entry.daemonId, entry.machineName, entry.view.config.id])).toEqual([
      [LAPTOP, 'laptop', 'q'],
      [STUDIO, 'studio', 'h'],
      [STUDIO, 'studio', 'y'],
    ]);
    const studio = view.machines[0];
    expect(studio?.total).toBe(3);
    expect(studio?.needsYou).toBe(2);
    expect(studio?.groups.flatMap(group => group.rows.map(row => row.config.id))).toEqual(['b']);
    expect(view.machines[1]?.groups).toEqual([]);
    // The human flag rides on a running session, so it counts as both.
    expect(view.counts).toEqual({ all: 4, auto: 4, interactive: 0 });
    expect(view.hiddenStopped).toBe(0);
    expect(view.total).toBe(4);
    expect(view.loaded).toBe(true);
  });

  test('ties break by machine order, then by id', () => {
    const twin = sessionView('a', { state: { status: 'awaiting_user', turnStateAt: at(0), attention: open(0) } });
    const view = allMachinesView([machine(STUDIO, [you, twin]), machine(LAPTOP, [twin])]);
    expect(view.needsYou.map(entry => `${entry.daemonId}:${entry.view.config.id}`)).toEqual([
      'studio:a',
      'studio:y',
      'laptop:a',
    ]);
  });

  test('an offline machine keeps its waiting rows at home and its last read time', () => {
    const view = allMachinesView([machine(LAPTOP, [you, busy], 'offline', { readAt: 42 })]);
    expect(view.needsYou).toEqual([]);
    expect(view.machines[0]?.readAt).toBe(42);
    expect(view.machines[0]?.groups.flatMap(group => group.rows.map(row => row.config.id)).sort()).toEqual(['b', 'y']);
    expect(allMachinesView([machine(STUDIO, [])]).machines[0]?.readAt).toBeNull();
  });

  test('a kind other than All shows only the machines it found something on; select narrows first', () => {
    const person = sessionView('p', {
      config: { mode: 'interactive' },
      state: { status: 'awaiting_user', attention: open(2) },
    });
    const machines = [machine(STUDIO, [busy, you]), machine(LAPTOP, [person], 'offline')];
    const agents = allMachinesView(machines, { filter: { mode: 'auto', showStopped: true } });
    expect(agents.machines.map(section => section.daemonId)).toEqual([STUDIO]);
    expect(agents.needsYou.map(entry => entry.view.config.id)).toEqual(['y']);
    const people = allMachinesView(machines, { filter: { mode: 'interactive', showStopped: true } });
    expect(people.needsYou).toEqual([]);
    expect(people.machines.map(section => section.daemonId)).toEqual([LAPTOP]);
    const everyone = allMachinesView(machines, { filter: { mode: 'all', showStopped: true } });
    expect(everyone.machines.map(section => section.daemonId)).toEqual([STUDIO, LAPTOP]);
    const narrowed = allMachinesView(machines, { select: sessions => sessions.filter(view => view.config.id !== 'y') });
    expect(narrowed.total).toBe(2);
    expect(narrowed.needsYou.map(entry => entry.view.config.id)).toEqual([]);
  });

  test('hides stopped sessions across machines until asked, and keeps the open one of ITS machine', () => {
    const done = sessionView('same-id', { state: { status: 'completed' } });
    const machines = [machine(STUDIO, [busy, done]), machine(LAPTOP, [done])];
    const hidden = allMachinesView(machines, { filter: { mode: 'all', showStopped: false } });
    expect(hidden.counts.all).toBe(1);
    expect(hidden.hiddenStopped).toBe(2);
    expect(hidden.machines.map(section => section.groups.length)).toEqual([1, 0]);
    const keepStudios = allMachinesView(machines, {
      filter: { mode: 'all', showStopped: false },
      keep: (daemonId, view) => daemonId === STUDIO && view.config.id === 'same-id',
    });
    expect(keepStudios.counts.all).toBe(2);
    expect(keepStudios.hiddenStopped).toBe(1);
    expect(keepStudios.machines.map(section => section.total)).toEqual([2, 0]);
  });

  test('reads as loading until any machine has answered', () => {
    expect(allMachinesView([machine(STUDIO, null, 'reading')]).loaded).toBe(false);
    expect(allMachinesView([]).loaded).toBe(false);
  });

  test('sorts rows inside a project when asked', () => {
    const older = sessionView('old', { config: { cwd: '/work/ferretry' }, state: { lastActivityAt: at(1) } });
    const newer = sessionView('new', { config: { cwd: '/work/ferretry' }, state: { lastActivityAt: at(9) } });
    const view = allMachinesView([machine(STUDIO, [older, newer])], { sortRows: true });
    expect(view.machines[0]?.groups[0]?.rows.map(row => row.config.id)).toEqual(['new', 'old']);
  });
});

describe('labels and order', () => {
  test('a short age at every scale', () => {
    expect(shortAge(-5)).toBe('0s');
    expect(shortAge(40_000)).toBe('40s');
    expect(shortAge(5 * 60_000)).toBe('5m');
    expect(shortAge(3 * 3_600_000)).toBe('3h');
    expect(shortAge(50 * 3_600_000)).toBe('2d');
  });

  test('what a heading says after the name', () => {
    expect(machineReachLabel({ reach: 'online', readAt: 0 }, 0)).toBe('');
    expect(machineReachLabel({ reach: 'reading', readAt: null }, 0)).toBe('reading…');
    expect(machineReachLabel({ reach: 'locked', readAt: null }, 0)).toBe('locked · open it to unlock');
    expect(machineReachLabel({ reach: 'offline', readAt: null }, 0)).toBe('offline');
    expect(machineReachLabel({ reach: 'offline', readAt: 0 }, 300_000)).toBe('offline · last seen 5m');
  });

  test('in the order they were paired, whichever machine is on screen or was chosen last', () => {
    // The registry lists the most recently chosen first; the list must not follow it, or a click moves it.
    const list = [
      { daemonId: STUDIO, pairedAt: 30 },
      { daemonId: 'third' as DaemonId, pairedAt: 20 },
      { daemonId: LAPTOP, pairedAt: 10 },
      { daemonId: 'twin' as DaemonId, pairedAt: 20 },
    ];
    expect(machineDisplayOrder(list).map(entry => String(entry.daemonId))).toEqual([
      'laptop',
      'third',
      'twin',
      'studio',
    ]);
    expect(machineDisplayOrder([...list].reverse())).toEqual(machineDisplayOrder(list));
  });
});

describe('needs-you is only open Attention', () => {
  test('a Your turn session with no Attention item is not pinned, and grouping off pins nothing', () => {
    const turn = sessionView('t', { state: { status: 'awaiting_user', turnStateAt: at(0) } });
    expect(allMachinesView([machine(STUDIO, [turn, human])]).needsYou.map(e => e.view.config.id)).toEqual(['h']);
    const off = allMachinesView([machine(STUDIO, [turn, human])], { groupNeedsYou: false });
    expect(off.needsYou).toEqual([]);
    expect(off.machines[0]?.groups.flatMap(group => group.rows.map(row => row.config.id)).sort()).toEqual(['h', 't']);
  });
});
