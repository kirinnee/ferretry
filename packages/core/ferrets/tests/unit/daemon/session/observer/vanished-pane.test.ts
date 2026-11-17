import { afterEach, describe, expect, it } from 'bun:test';
import { type FerretId, type FerretRecord, type RunnerExit, type RunnerHandle } from '../../../../../contract/index.ts';
import { FakeRunner, T0 as RECORD_T0 } from '../../../../../contract/testing/index.ts';
import { buildTurnWatch } from '../../../../../daemon/modules/turn-watch.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig } from '../../../../support/daemon/storage.ts';

const AT = '2026-11-08T10:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Settled {
  readonly ferret: FerretId;
  readonly handle: string;
  readonly from: string;
  readonly reason: string;
}

/** A live ferret on a fake pane, the turn watch over it, and a way to tick it once and let its settle land. */
async function watched(state: 'working' | 'idle' = 'working', status: 'running' | 'waiting' = 'running') {
  const made = await memoryStorage({ clock: { now: () => AT } });
  cleanups.push(async () => await made.storage.close());
  const id = parseSessionId('vanish-1');
  await made.storage.writeConfig(id, sessionConfig(id));
  // A declared wait (and a converted v4 copy) has no turn state: the watch's roster drops it, so only the sweep can ask.
  await made.storage.writeState(
    id,
    status === 'running' ? { id, status, turn: 1, turnState: 'working', turnStateAt: AT } : { id, status, turn: 1 },
  );
  const runner = new FakeRunner();
  const record = {
    format: 1,
    id: id as unknown as FerretId,
    name: id,
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work/vanish-1',
    state,
    handle: runner.adoptable(id as unknown as FerretId),
    createdAt: RECORD_T0,
    stateAt: RECORD_T0,
  } as FerretRecord;
  const settled: Settled[] = [];
  const stillGones: Array<() => Promise<boolean>> = [];
  const settledExits: Array<{ ferret: FerretId; handle: string; exit: RunnerExit; from: string }> = [];
  const stillExiteds: Array<() => Promise<boolean>> = [];
  let timer: (() => void) | undefined;
  const log = new RecordingLog();
  const timers: Array<() => void> = [];
  const { host, startSweep } = buildTurnWatch({
    storage: made.storage,
    tail: { tail: async () => ({ kind: 'unresolved' }) },
    record: () => record,
    live: () => [record],
    runner: () => runner,
    turnObserved: async () => undefined,
    settleGone: async (ferret, handle, exited, stillGone) => {
      settled.push({ ferret, handle, ...exited });
      stillGones.push(stillGone);
      return true;
    },
    settleExited: async (ferret, handle, exit, from, stillExited) => {
      settledExits.push({ ferret, handle, exit, from });
      stillExiteds.push(stillExited);
      return true;
    },
    clock: { now: () => AT },
    every: (_intervalMs, tick) => {
      timers.push(tick);
      timer = timers[0];
      return () => undefined;
    },
    yieldToLoop: async () => undefined,
    log,
  });
  host.arm();
  const tick = async (): Promise<void> => {
    timer?.();
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  /** One run of the 30 s sweep over every live registry record. */
  const sweep = async (): Promise<void> => {
    startSweep();
    timers[timers.length - 1]?.();
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  return {
    runner,
    record,
    settled,
    stillGones,
    settledExits,
    stillExiteds,
    tick,
    sweep,
    id: id as unknown as FerretId,
  };
}

describe('a ferret whose terminal vanished', () => {
  it('is settled gone, on the handle it ran on, once the runner proves the pane is not there', async () => {
    const fleet = await watched('working');
    fleet.runner.reboot();

    await fleet.tick();

    expect(fleet.settled).toEqual([
      {
        ferret: fleet.id,
        handle: fleet.record.handle as string,
        from: 'running',
        reason: 'the agent is no longer running: its terminal is gone, so how it exited was not recorded',
      },
    ]);
  });

  it('is asked again inside the settle: a pane id reused by a relaunch is not the pane that vanished', async () => {
    const fleet = await watched('working');
    fleet.runner.reboot();
    await fleet.tick();
    const [stillGone] = fleet.stillGones;
    expect(await stillGone?.()).toBe(true);

    // A restart ran while the settle waited its turn: a live pane now answers to the ferret.
    fleet.runner.adoptable(fleet.id);

    expect(await stillGone?.()).toBe(false);
  });

  it('is settled gone by the sweep while its document says `waiting` (the watch never looks at it)', async () => {
    const fleet = await watched('working', 'waiting');
    fleet.runner.reboot();

    await fleet.tick();
    expect(fleet.settled).toEqual([]);
    await fleet.sweep();

    expect(fleet.settled.map(one => one.handle)).toEqual([fleet.record.handle as string]);
  });

  it('is asked about by the sweep and left alone while its pane is alive', async () => {
    const fleet = await watched('working', 'waiting');

    await fleet.sweep();

    expect(fleet.runner.goneAsked).toEqual([fleet.id]);
    expect(fleet.settled).toEqual([]);
  });

  it('is not asked about by the sweep once the registry says it is stopped', async () => {
    const fleet = await watched();
    fleet.runner.reboot();
    (fleet.record as { state: string }).state = 'stopped';

    await fleet.sweep();

    expect(fleet.runner.goneAsked).toEqual([]);
    expect(fleet.settled).toEqual([]);
  });

  it('says it was between turns when it was idle', async () => {
    const fleet = await watched('idle');
    fleet.runner.reboot();

    await fleet.tick();

    expect(fleet.settled.map(one => one.from)).toEqual(['awaiting_user']);
  });

  it('is left alone while its pane is alive', async () => {
    const fleet = await watched();

    await fleet.tick();

    expect(fleet.runner.goneAsked).toEqual([]);
    expect(fleet.settled).toEqual([]);
  });

  it('is left alone when the runner cannot prove the terminal gone', async () => {
    const fleet = await watched();
    fleet.runner.reboot();
    fleet.runner.goneAnswer = false;

    await fleet.tick();

    expect(fleet.runner.goneAsked).toEqual([fleet.id]);
    expect(fleet.settled).toEqual([]);
  });

  it('is left alone, and the watch keeps going, when the runner cannot answer', async () => {
    const fleet = await watched();
    fleet.runner.reboot();
    fleet.runner.goneAnswer = 'throw';

    await fleet.tick();

    expect(fleet.settled).toEqual([]);
  });

  it('is not settled once the registry says it is stopped (an owner stop is never turned into a gone terminal)', async () => {
    const fleet = await watched();
    fleet.runner.reboot();
    (fleet.record as { state: string }).state = 'stopped';

    await fleet.tick();

    expect(fleet.runner.goneAsked).toEqual([]);
    expect(fleet.settled).toEqual([]);
  });
});

describe('a ferret whose pane is kept dead (the harness was killed or crashed)', () => {
  it('is settled with how it ended, on the handle it ran on, by the watch', async () => {
    const fleet = await watched('working');
    fleet.runner.die(fleet.record.handle as RunnerHandle, { signal: 9 });

    await fleet.tick();

    expect(fleet.settledExits).toEqual([
      {
        ferret: fleet.id,
        handle: fleet.record.handle as string,
        exit: { signal: 9 },
        from: 'running',
      },
    ]);
    // A terminal that is there is no vanished terminal.
    expect(fleet.settled).toEqual([]);
  });

  it('is settled by the sweep while its document says `waiting` (the watch never looks at it)', async () => {
    const fleet = await watched('working', 'waiting');
    fleet.runner.die(fleet.record.handle as RunnerHandle, { status: 1 });

    await fleet.tick();
    expect(fleet.settledExits).toEqual([]);
    await fleet.sweep();

    expect(fleet.settledExits.map(one => one.exit)).toEqual([{ status: 1 }]);
  });

  it('says it was between turns when it was idle', async () => {
    const fleet = await watched('idle');
    fleet.runner.die(fleet.record.handle as RunnerHandle, { status: 2 });

    await fleet.tick();

    expect(fleet.settledExits.map(one => one.from)).toEqual(['awaiting_user']);
  });

  it('is asked again inside the settle: a live pane a relaunch put on the same handle is not the dead one', async () => {
    const fleet = await watched('working');
    const handle = fleet.record.handle as RunnerHandle;
    fleet.runner.die(handle, { signal: 9 });
    await fleet.tick();
    const [stillExited] = fleet.stillExiteds;
    expect(await stillExited?.()).toBe(true);

    // The relaunch cleared the corpse and a live pane answers on the very same handle.
    fleet.runner.deadPanes.delete(handle);

    expect(await stillExited?.()).toBe(false);
  });

  it('is never read dead while its pane is alive', async () => {
    const fleet = await watched('working', 'waiting');

    await fleet.sweep();

    expect(fleet.runner.exitedAsked).toEqual([[fleet.id, fleet.record.handle as RunnerHandle]]);
    expect(fleet.settledExits).toEqual([]);
  });

  it('is left alone, and the watch keeps going, when the runner cannot answer', async () => {
    const fleet = await watched('working');
    fleet.runner.die(fleet.record.handle as RunnerHandle, { signal: 9 });
    fleet.runner.exitedAnswer = 'throw';

    await fleet.tick();

    expect(fleet.settledExits).toEqual([]);
  });

  it('is not asked about once the registry says it is stopped (an owner stop is never turned into a crash)', async () => {
    const fleet = await watched();
    fleet.runner.die(fleet.record.handle as RunnerHandle, { signal: 2 });
    (fleet.record as { state: string }).state = 'stopped';

    await fleet.tick();
    await fleet.sweep();

    expect(fleet.runner.exitedAsked).toEqual([]);
    expect(fleet.settledExits).toEqual([]);
  });
});
