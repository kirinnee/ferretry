import { describe, expect, test } from 'bun:test';
import type { FerretId, FerretRecord } from '../../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../../contract/testing/index.ts';
import {
  type BootExitFerrets,
  bootExitTransition,
  claimsBootAgent,
  FerretBootExits,
  owedAutoResume,
  RegistryAutoResumeRoster,
} from '../../../../../daemon/adapters/session/auto-resume/index.ts';
import { exitedSessionTransition } from '../../../../../daemon/lib/session/health/exit.ts';

const record = (id: string, state: FerretRecord['state'], extra: Partial<FerretRecord> = {}): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${id}`,
  state,
  createdAt: T0,
  stateAt: T0,
  ...extra,
});

function world(records: readonly FerretRecord[], over: Partial<BootExitFerrets> = {}) {
  const settled: { ferret: FerretId; handle: string | undefined; from: string; reason: string }[] = [];
  const port: BootExitFerrets = {
    list: () => records,
    status: async () => 'running',
    gone: async () => true,
    settle: async (ferret, handle, exited) => {
      settled.push({ ferret, handle, from: exited.from, reason: exited.reason });
      return true;
    },
    ...over,
  };
  return { exits: new FerretBootExits(port), settled };
}

describe('the boot exit pass over the registry', () => {
  test('a working ferret on a handle whose document claims an agent and whose pane is proven gone is observed gone', async () => {
    const { exits } = world([record('a', 'working', { handle: '%1' })]);
    const observed = await exits.observe();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      id: ferretId('a'),
      status: 'running',
      exit: { kind: 'gone' },
      registration: { sessionId: ferretId('a'), paneId: '%1' },
    });
  });

  test('an idle ferret is observed as between turns, so a revive is not told it was mid-turn', async () => {
    const { exits } = world([record('b', 'idle', { handle: '%2' })]);
    expect((await exits.observe())[0]?.status).toBe('awaiting_user');
  });

  test('a ferret that is starting or stopped is never observed, handle or not', async () => {
    const { exits } = world([
      record('c', 'starting', { handle: '%3' }),
      record('d', 'starting'),
      record('e', 'stopped', { handle: '%5' }),
      record('f', 'stopped'),
    ]);
    expect(await exits.observe()).toEqual([]);
  });

  test('FX3: a handle-less working ferret (a converted v4 copy) whose pane is proven gone is observed, and settled on NO handle', async () => {
    const { exits, settled } = world([record('h', 'working')]);
    const observed = await exits.observe();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ id: ferretId('h'), status: 'running', exit: { kind: 'gone' } });
    const transition = exitedSessionTransition(observed[0]!)!;
    expect(await exits.settle(observed[0]!, transition)).toBe(true);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ ferret: ferretId('h'), handle: undefined, from: 'running' });
  });

  test('FX3: a handle-less idle ferret is observed as between turns and settled on NO handle', async () => {
    const { exits, settled } = world([record('i', 'idle')]);
    const [observation] = await exits.observe();
    expect(observation?.status).toBe('awaiting_user');
    expect(await exits.settle(observation!, exitedSessionTransition(observation!)!)).toBe(true);
    expect(settled[0]).toMatchObject({ ferret: ferretId('i'), handle: undefined, from: 'awaiting_user' });
  });

  test('FX3: a handle-less ferret is left alone when its document claims no agent or its pane is not proven gone', async () => {
    const live = [record('h', 'working')];
    for (const over of [
      { status: async () => 'completed' },
      { status: async () => undefined },
      { gone: async () => false },
      { gone: async () => await Promise.reject(new Error('runner down')) },
    ] satisfies Partial<BootExitFerrets>[])
      expect(await world(live, over).exits.observe()).toEqual([]);
  });

  for (const status of ['rate_limited', 'retrying', 'kill_failed'])
    test(`W3-1 a ferret parked on ${status} whose pane is proven gone is observed gone (with or without a handle), keeping its real status`, async () => {
      const { exits, settled } = world([record('p', 'working', { handle: '%7' }), record('q', 'idle')], {
        status: async () => status,
      });
      const observed = await exits.observe();
      expect(observed.map(each => [each.id, each.status])).toEqual([
        [ferretId('p'), status],
        [ferretId('q'), 'awaiting_user'],
      ]);
      for (const observation of observed) {
        const transition = bootExitTransition(observation);
        expect(transition).toMatchObject({ status: 'failed', health: 'unknown' });
        expect(await exits.settle(observation, transition!)).toBe(true);
      }
      expect(settled.map(each => each.handle)).toEqual(['%7', undefined]);
    });

  test('W3-1 only the boot pass reads a parked status as an agent; the health port still declines it, and the rest stay refused', () => {
    expect(['rate_limited', 'retrying', 'kill_failed', 'running', 'awaiting_user'].map(claimsBootAgent)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      ['stopped', 'completed', 'failed', 'starting', 'created', 'stalled', undefined].map(claimsBootAgent),
    ).toEqual([false, false, false, false, false, false, false]);
  });

  test('a document that claims no agent, or cannot be read, or a pane not proven gone, is left alone', async () => {
    const live = [record('a', 'working', { handle: '%1' })];
    for (const over of [
      { status: async () => 'completed' },
      { status: async () => undefined },
      { status: async () => await Promise.reject(new Error('unreadable')) },
      { gone: async () => false },
      { gone: async () => await Promise.reject(new Error('runner down')) },
    ] satisfies Partial<BootExitFerrets>[])
      expect(await world(live, over).exits.observe()).toEqual([]);
  });

  test('a gone observation with a failed transition settles the ferret on its pane, naming where it was and why', async () => {
    const { exits, settled } = world([record('a', 'working', { handle: '%1' })]);
    const [observation] = await exits.observe();
    const transition = exitedSessionTransition(observation!);
    expect(transition).toBeDefined();
    expect(await exits.settle(observation!, transition!)).toBe(true);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ ferret: ferretId('a'), handle: '%1', from: 'running' });
    expect(settled[0]?.reason).toBe(transition!.reason);
  });

  test("settle answers false when the port's compare-and-set did not land, and settles nothing for another kind of exit or transition", async () => {
    const { exits, settled } = world([record('a', 'working', { handle: '%1' })], { settle: async () => false });
    const [observation] = await exits.observe();
    const transition = exitedSessionTransition(observation!)!;
    expect(await exits.settle(observation!, transition)).toBe(false);
    const other = world([record('a', 'working', { handle: '%1' })]);
    expect(
      await other.exits.settle({ ...observation!, exit: { kind: 'exited', exitStatus: 1 } as never }, transition),
    ).toBe(false);
    expect(await other.exits.settle(observation!, { ...transition, status: 'completed' } as never)).toBe(false);
    expect(other.settled).toEqual([]);
    expect(settled).toEqual([]);
  });
});

describe('the registry roster', () => {
  test('owed means stopped because the terminal was proven gone, and nothing else', () => {
    const cause = (kind: string): Partial<FerretRecord> => ({ cause: { kind } as never });
    expect(owedAutoResume(record('a', 'stopped', cause('terminal_gone')))).toBe(true);
    expect(owedAutoResume(record('a', 'stopped', cause('stopped')))).toBe(false);
    expect(owedAutoResume(record('a', 'stopped'))).toBe(false);
    expect(owedAutoResume(record('a', 'working', cause('terminal_gone')))).toBe(false);
    expect(owedAutoResume(undefined)).toBe(false);
  });

  test("a subject reads failed when owed, else the ferret's own state, with its mode defaulting to auto", async () => {
    const records = new Map<string, FerretRecord>([
      ['owed', record('owed', 'stopped', { cause: { kind: 'terminal_gone' } as never })],
      ['live', record('live', 'working', { mode: 'interactive' })],
    ]);
    const roster = new RegistryAutoResumeRoster(ferret => records.get(ferret));
    expect(await roster.subject('owed')).toEqual({ status: 'failed', mode: 'auto' });
    expect(await roster.subject('live')).toEqual({ status: 'working', mode: 'interactive' });
    expect(await roster.subject('gone')).toBeUndefined();
  });
});
