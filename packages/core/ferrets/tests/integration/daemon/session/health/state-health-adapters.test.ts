import { describe, it } from 'bun:test';
import { state as hostState } from '@ferretry/kernel/host';
import should from 'should';
import { HealthEventsFile, SelfRestartFile } from '../../../../../contract/index.ts';
import {
  HEALTH_EVENTS_MAX_BYTES,
  StateSelfRestartStampStore,
  StateSessionHealthEventSink,
  SystemMonotonicClock,
  UnmountedSupervisionRepair,
} from '../../../../../daemon/adapters/session/health/index.ts';

/**
 * The health files Ferrets keeps through its own state port: the event journal (`health.jsonl`) and the self-restart
 * cooldown (`self-restart.json`). The port is the kernel's real one over an in-memory disk, so a damaged file is
 * refused with the real sentence rather than a fake's.
 */

const NOW = '2026-07-31T10:00:00.000Z';
const HOME = '/home/health-test';

function world() {
  const fs = hostState.createMemoryHostFs();
  const state = hostState.createStatePort({
    home: HOME,
    pluginId: 'ferrets',
    files: [HealthEventsFile, SelfRestartFile],
    fs,
  });
  const at = (file: string): string => `${hostState.pluginStateRoot(HOME, 'ferrets')}/${file}`;
  return { fs, state, at };
}

describe('self-restart stamp store', () => {
  it('should report no stamp at all before anything has restarted', async () => {
    // Arrange
    const store = new StateSelfRestartStampStore(world().state);

    // Act
    const actual = await store.read();

    // Assert
    should(actual).be.undefined();
  });

  it('should round-trip a stamp through the state port', async () => {
    // Arrange
    const { state, fs, at } = world();
    const store = new StateSelfRestartStampStore(state);

    // Act
    await store.write({ at: NOW, sessions: ['a', 'b'] });
    const actual = await store.read();

    // Assert
    should(actual).deepEqual({ at: NOW, sessions: ['a', 'b'] });
    should(JSON.parse((await fs.readText(at('self-restart.json'))) ?? '{}')).match({ format: 1, at: NOW });
  });

  it('should throw on a corrupt stamp rather than reporting an absent one', async () => {
    // Arrange — reading a torn stamp as "nothing restarted" is what disables the restart-loop brake.
    const { state, fs, at } = world();
    fs.seed(at('self-restart.json'), '{ this is not json');
    const store = new StateSelfRestartStampStore(state);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should throw on a stamp whose shape does not match the schema', async () => {
    // Arrange
    const { state, fs, at } = world();
    fs.seed(at('self-restart.json'), JSON.stringify({ format: 1, at: 'the other day' }));
    const store = new StateSelfRestartStampStore(state);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should clear a stamp, and stay silent when there was none to clear', async () => {
    // Arrange
    const store = new StateSelfRestartStampStore(world().state);
    await store.write({ at: NOW, sessions: [] });

    // Act
    await store.clear();
    await store.clear();

    // Assert
    should(await store.read()).be.undefined();
  });
});

describe('health event sink', () => {
  it('should append one stamped line per event to health.jsonl', async () => {
    // Arrange
    const { state } = world();
    const sink = new StateSessionHealthEventSink(state, { now: () => NOW });

    // Act
    await sink.emit({ type: 'fleet.daemon_wedge', data: { gapSeconds: 200 } });
    await sink.emit({ type: 'fleet.index_incoherent', data: { consecutive: 1 } });

    // Assert
    const lines: unknown[] = [];
    for await (const line of state.lines(HealthEventsFile)) lines.push(line);
    should(lines).deepEqual([
      { at: NOW, type: 'fleet.daemon_wedge', data: { gapSeconds: 200 } },
      { at: NOW, type: 'fleet.index_incoherent', data: { consecutive: 1 } },
    ]);
  });
});

describe('health event journal cap', () => {
  const big = 'x'.repeat(100 * 1024);
  /** The persistent fault, numbered: the same event every check, so its order is told by `n`. */
  const fault = (n: number) => ({ type: 'fleet.index_incoherent' as const, data: { n, big } });
  const numbersOf = async (state: ReturnType<typeof world>['state']): Promise<unknown[]> => {
    const numbers: unknown[] = [];
    for await (const line of state.lines(HealthEventsFile)) numbers.push(line.data.n);
    return numbers;
  };

  it('should compact to the newest events once a persistent fault has grown the file past its cap', async () => {
    // Arrange — a fault that writes a 100 KiB line (far above a real one) every check.
    const { state, fs, at } = world();
    const sink = new StateSessionHealthEventSink(state, { now: () => NOW });

    // Act
    for (let n = 0; n < 12; n += 1) await sink.emit(fault(n));

    // Assert — bounded, newest kept, oldest gone, every line still whole.
    const size = (await fs.readText(at('health.jsonl')))?.length ?? 0;
    const numbers = await numbersOf(state);
    should(size).be.belowOrEqual(HEALTH_EVENTS_MAX_BYTES);
    should(numbers.at(-1)).equal(11);
    should(numbers).not.containEql(0);
    should(numbers.length).be.greaterThan(0);
  });

  it('should leave the journal alone below its cap', async () => {
    // Arrange
    const { state } = world();
    const sink = new StateSessionHealthEventSink(state, { now: () => NOW });

    // Act
    for (let n = 0; n < 5; n += 1) await sink.emit(fault(n));

    // Assert
    should(await numbersOf(state)).deepEqual([0, 1, 2, 3, 4]);
  });

  it('should still have written the event when the compaction itself fails', async () => {
    // Arrange
    const { state } = world();
    const failing = {
      append: state.append.bind(state),
      version: state.version.bind(state),
      write: state.write.bind(state),
      tail: async () => {
        throw new Error('the disk is full');
      },
    };
    const sink = new StateSessionHealthEventSink(failing as never, { now: () => NOW });

    // Act
    for (let n = 0; n < 8; n += 1) await sink.emit(fault(n));

    // Assert — nothing was compacted and nothing was lost.
    should((await numbersOf(state)).length).equal(8);
  });
});

describe('unmounted supervision repair', () => {
  it('should refuse loudly rather than pretend a repair happened', async () => {
    // Arrange
    const repair = new UnmountedSupervisionRepair();

    // Act / Assert
    await should(repair.startMonitor('any')).be.rejectedWith(/no session monitor subsystem is mounted/u);
    await should(repair.rearmWarden()).be.rejectedWith(/no warden sweep timer is mounted/u);
  });
});

describe('system monotonic clock', () => {
  it('should never go backwards between two readings', async () => {
    // Arrange
    const clock = new SystemMonotonicClock();

    // Act
    const first = clock.elapsedMs();
    await Bun.sleep(2);
    const second = clock.elapsedMs();

    // Assert
    should(Number.isFinite(first)).be.true();
    should(second).be.greaterThanOrEqual(first);
  });
});
