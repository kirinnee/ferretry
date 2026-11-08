/** W2-a: the 5.0 adapters the mounted auto-resume stands on (boot exits, state ledger and summary, registry roster). */
import { describe, expect, test } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import {
  AutoResumeFile,
  AutoResumeSummaryFile,
  type FerretId,
  type FerretRecord,
} from '../../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../../contract/testing/index.ts';
import {
  BootExitRecorder,
  type BootExitFerrets,
  FerretBootExits,
  owedAutoResume,
  RegistryAutoResumeRoster,
  StateAutoResumeLedger,
  StateAutoResumeSummaryStore,
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

function ferrets(records: readonly FerretRecord[], over: Partial<BootExitFerrets> = {}) {
  const settled: { ferret: FerretId; handle: string; from: string }[] = [];
  const port: BootExitFerrets = {
    list: () => records,
    status: async () => 'running',
    gone: async () => true,
    settle: async (ferret, handle, exited) => {
      settled.push({ ferret, handle, from: exited.from });
      return true;
    },
    ...over,
  };
  return { port, settled };
}

async function pass(exits: BootExitRecorder) {
  for (const observation of await exits.observe([])) {
    const transition = exitedSessionTransition(observation);
    if (transition !== undefined) await exits.settle(observation, transition);
  }
  return exits.close();
}

describe("W2-a the boot exit pass (today's first self-check, over the registry)", () => {
  test('W2-a only a live ferret on a handle whose document claims an agent and whose terminal is PROVEN gone is recorded', async () => {
    const { port, settled } = ferrets([
      record('a', 'working', { handle: '%1' }),
      record('b', 'idle', { handle: '%2' }),
      record('c', 'starting', { handle: '%3' }),
      record('d', 'working'),
      record('e', 'stopped', { handle: '%5' }),
    ]);
    const found = await pass(new BootExitRecorder(new FerretBootExits(port), { now: () => T0 }));
    expect(found.map(candidate => candidate.id)).toEqual([ferretId('a'), ferretId('b')]);
    expect(settled).toEqual([
      { ferret: ferretId('a'), handle: '%1', from: 'running' },
      { ferret: ferretId('b'), handle: '%2', from: 'awaiting_user' },
    ]);
  });

  test("W2-a a ferret between turns is recorded as today's idle status, so it is not told it was mid-turn", async () => {
    const { port } = ferrets([record('b', 'idle', { handle: '%2' })]);
    const found = await pass(new BootExitRecorder(new FerretBootExits(port), { now: () => T0 }));
    expect(found[0]?.status).toBe('awaiting_user');
  });

  test('W2-a a document that claims no live agent (kill_failed, stopped, none) is never observed', async () => {
    for (const status of ['kill_failed', 'stopped', 'starting', undefined]) {
      const { port, settled } = ferrets([record('a', 'working', { handle: '%1' })], { status: async () => status });
      expect(await new FerretBootExits(port).observe()).toEqual([]);
      expect(await pass(new BootExitRecorder(new FerretBootExits(port), { now: () => T0 }))).toEqual([]);
      expect(settled).toEqual([]);
    }
  });

  test('W2-a nothing proven is nothing settled: gone false, gone throws, status throws', async () => {
    const cases: Partial<BootExitFerrets>[] = [
      { gone: async () => false },
      { gone: async () => Promise.reject(new Error('socket refused')) },
      { status: async () => Promise.reject(new Error('unreadable')) },
    ];
    for (const over of cases) {
      const { port, settled } = ferrets([record('a', 'working', { handle: '%1' })], over);
      expect(await pass(new BootExitRecorder(new FerretBootExits(port), { now: () => T0 }))).toEqual([]);
      expect(settled).toEqual([]);
    }
  });

  test('W2-a a settle that did not land (someone moved first) is not recorded', async () => {
    const { port } = ferrets([record('a', 'working', { handle: '%1' })], { settle: async () => false });
    expect(await pass(new BootExitRecorder(new FerretBootExits(port), { now: () => T0 }))).toEqual([]);
  });

  test('W2-a the settle refuses anything but a gone pane failing', async () => {
    const { port, settled } = ferrets([]);
    const exits = new FerretBootExits(port);
    const registration = {
      daemonId: '',
      sessionId: 'a',
      tmuxSession: '',
      paneId: '%1',
      pid: 0,
      processStartTicks: 0,
      sessionCreated: 0,
    };
    expect(
      await exits.settle(
        { id: 'a', status: 'running', registration, exit: { kind: 'exited', exitStatus: 1 } },
        { status: 'failed', health: 'crashed', reason: 'x' },
      ),
    ).toBe(false);
    expect(
      await exits.settle(
        { id: 'a', status: 'running', registration, exit: { kind: 'gone' } },
        {
          status: 'completed',
          health: 'idle',
          reason: 'x',
        },
      ),
    ).toBe(false);
    expect(settled).toEqual([]);
  });
});

/** Ferrets' own state documents in memory, as the kernel's port strips and stamps `format`. */
function memoryState(read?: () => Promise<never>) {
  const files = new Map<string, unknown>();
  const state: Pick<StatePort, 'read' | 'write' | 'remove'> = {
    read: async <Shape>(file: StateFileDef<string, Shape>) =>
      read !== undefined ? await read() : ok(files.get(file.path) as Shape | undefined),
    write: async (file, value) => {
      files.set(file.path, structuredClone(value));
    },
    remove: async file => {
      files.delete(file.path);
    },
  };
  return { state, files };
}

describe("W2-a F-0109 the ledger and F-0108 the summary, in Ferrets' state", () => {
  const candidates = [{ id: 'mw7bp88g-50e00159', status: 'running', at: T0 }];

  test('F-0109 the ledger round-trips and is removed when nothing is owed', async () => {
    const { state, files } = memoryState();
    const ledger = new StateAutoResumeLedger(state);
    await ledger.write(candidates);
    expect(files.get(AutoResumeFile.path)).toEqual({ candidates });
    expect(await ledger.read()).toEqual(candidates);
    await ledger.write([]);
    expect(files.has(AutoResumeFile.path)).toBe(false);
    expect(await ledger.read()).toEqual([]);
  });

  test('F-0109 a foreign, damaged or unreadable ledger reads as nothing owed (nobody is resumed on it)', async () => {
    const { state, files } = memoryState();
    const ledger = new StateAutoResumeLedger(state);
    for (const body of [{ version: 1, candidates }, { candidates: [{ id: 'x' }] }, 'torn', null])
      files.set(AutoResumeFile.path, body);
    expect(await ledger.read()).toEqual([]);
    expect(
      await new StateAutoResumeLedger(memoryState(async () => Promise.reject(new Error('io')) as never).state).read(),
    ).toEqual([]);
    const damaged = memoryState();
    damaged.state.read = async () => err({ file: 'auto-resume.json' } as never);
    expect(await new StateAutoResumeLedger(damaged.state).read()).toEqual([]);
  });

  test('F-0108 the summary round-trips; nothing, garbage or an unreadable document reads null', async () => {
    const { state, files } = memoryState();
    const store = new StateAutoResumeSummaryStore(state);
    expect(await store.read()).toBe(null);
    const summary = { at: T0, resumed: 1, skipped: [{ sessionId: 'mw7bp88g-50e00159', reason: 'no' }] };
    await store.write(summary);
    expect(await store.read()).toEqual(summary);
    files.set(AutoResumeSummaryFile.path, { at: 'x' });
    expect(await store.read()).toBe(null);
  });
});

describe('W2-a the roster reads the registry', () => {
  test('W2-a only a ferret stopped because its terminal was PROVEN gone is still owed', () => {
    expect(owedAutoResume(record('a', 'stopped', { cause: { kind: 'terminal_gone' } }))).toBe(true);
    for (const cause of [{ kind: 'stopped' }, { kind: 'completed' }, { kind: 'tmux_crashed' }] as const)
      expect(owedAutoResume(record('a', 'stopped', { cause }))).toBe(false);
    expect(owedAutoResume(record('a', 'stopped'))).toBe(false);
    expect(owedAutoResume(record('a', 'working', { cause: { kind: 'terminal_gone' } }))).toBe(false);
    expect(owedAutoResume(undefined)).toBe(false);
  });

  test("W2-a an owed ferret reads today's `failed`; an archived one (no record) reads nothing", async () => {
    const held = new Map<string, FerretRecord>([
      [ferretId('a'), record('a', 'stopped', { cause: { kind: 'terminal_gone' }, mode: 'interactive' })],
      [ferretId('b'), record('b', 'stopped', { cause: { kind: 'stopped' } })],
    ]);
    const roster = new RegistryAutoResumeRoster(ferret => held.get(ferret));
    expect(await roster.subject(ferretId('a'))).toEqual({ status: 'failed', mode: 'interactive' });
    expect(await roster.subject(ferretId('b'))).toEqual({ status: 'stopped', mode: 'auto' });
    expect(await roster.subject(ferretId('gone'))).toBeUndefined();
  });
});
