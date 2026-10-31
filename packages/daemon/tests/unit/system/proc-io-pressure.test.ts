import { describe, it } from 'bun:test';
import should from 'should';
import { ProcIoPressure } from '../../../src/adapters/system/proc-io-pressure.ts';

const BUSY = 'some avg10=52.00 avg60=51.00 avg300=51.00 total=1\nfull avg10=46.00 avg60=45.00 avg300=44.00 total=1\n';
const CALM = 'some avg10=0.50 avg60=0.40 avg300=0.30 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n';

/** Serves `first` at once, then every later read from `late`, which the test settles by hand. */
function readerWithLateRead(first: string): {
  readText: () => Promise<string>;
  settle: (text: string | Error) => void;
} {
  let settle!: (text: string | Error) => void;
  const late = new Promise<string>((resolve, reject) => {
    settle = text => (typeof text === 'string' ? resolve(text) : reject(text));
  });
  let calls = 0;
  return { readText: async () => (calls++ === 0 ? first : await late), settle };
}

/** Holds a refresh in flight across `stop()`, then lets it finish. */
async function stopDuringRead(
  pressure: ProcIoPressure,
  settle: (text: string | Error) => void,
  outcome: string | Error,
) {
  await pressure.refresh();
  const stop = pressure.start();
  const inFlight = pressure.refresh();
  stop();
  settle(outcome);
  await inFlight;
}

describe('ProcIoPressure stop', () => {
  it('should ignore a read that finishes after stop()', async () => {
    // Arrange
    const { readText, settle } = readerWithLateRead(CALM);
    const pressure = new ProcIoPressure('/psi', 1_000_000, readText);

    // Act
    await stopDuringRead(pressure, settle, BUSY);

    // Assert
    should(pressure.current()?.some.avg10).equal(0.5);
  });

  it('should ignore a read that fails after stop()', async () => {
    // Arrange
    const { readText, settle } = readerWithLateRead(CALM);
    const pressure = new ProcIoPressure('/psi', 1_000_000, readText);

    // Act
    await stopDuringRead(pressure, settle, new Error('gone'));

    // Assert
    should(pressure.current()?.some.avg10).equal(0.5);
  });

  it('should still take a fresh refresh after stop()', async () => {
    // Arrange
    const pressure = new ProcIoPressure('/psi', 1_000_000, async () => BUSY);
    pressure.start()();

    // Act
    await pressure.refresh();

    // Assert
    should(pressure.current()?.some.avg10).equal(52);
  });
});
