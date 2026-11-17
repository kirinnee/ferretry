import { afterEach, describe, expect, it } from 'bun:test';
import { type FerretId, type FerretRecord } from '../../../../../contract/index.ts';
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
  await made.storage.writeState(id, { id, status, turn: 1, turnState: 'working', turnStateAt: AT });
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
  let timer: (() => void) | undefined;
  const log = new RecordingLog();
  const { host } = buildTurnWatch({
    storage: made.storage,
    tail: { tail: async () => ({ kind: 'unresolved' }) },
    record: () => record,
    runner: () => runner,
    turnObserved: async () => undefined,
    settleGone: async (ferret, handle, exited, stillGone) => {
      settled.push({ ferret, handle, ...exited });
      stillGones.push(stillGone);
      return true;
    },
    clock: { now: () => AT },
    every: (_intervalMs, tick) => {
      timer = tick;
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
  return { runner, record, settled, stillGones, tick, id: id as unknown as FerretId };
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

  it('is settled gone while its document says `waiting` (a status the watch never looks at)', async () => {
    const fleet = await watched('working', 'waiting');
    fleet.runner.reboot();

    await fleet.tick();

    expect(fleet.settled.map(one => one.handle)).toEqual([fleet.record.handle as string]);
  });

  it('is not asked about while `waiting` and its pane is alive', async () => {
    const fleet = await watched('working', 'waiting');

    await fleet.tick();

    expect(fleet.runner.goneAsked).toEqual([fleet.id]);
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
