/**
 * INDEPENDENT BROWSER CASES, TWO AT A TIME.
 *
 * Each case of a visual file opens a context of its own (its own storage, cookies and clock), so two of them
 * side by side prove what running them one after the other did, in less wall time. Two, because the runner has
 * two vCPUs. The cases run in the file's hook, ahead of its tests; each test then reports its own case's
 * outcome under its own name, in the order written, so a failure names the case that failed.
 *
 * Call it once, at the top of the file, after the file's own `beforeAll` (a hook runs in the order registered).
 * A case must not depend on another case or on anything it leaves behind.
 */
import { beforeAll, test } from 'bun:test';

const LANES = 2;

interface Lane {
  readonly run: () => Promise<void>;
  outcome: PromiseSettledResult<void> | undefined;
}

export const laneTests = (): ((name: string, run: () => Promise<void>) => void) => {
  const lanes: Lane[] = [];
  beforeAll(async () => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const lane = lanes[next];
        next += 1;
        if (lane === undefined) return;
        lane.outcome = await lane.run().then(
          (): PromiseSettledResult<void> => ({ status: 'fulfilled', value: undefined }),
          (reason: unknown): PromiseSettledResult<void> => ({ status: 'rejected', reason }),
        );
      }
    };
    await Promise.all(Array.from({ length: LANES }, worker));
  }, 240_000);

  return (name, run) => {
    const lane: Lane = { run, outcome: undefined };
    lanes.push(lane);
    test(name, () => {
      if (lane.outcome === undefined) throw new Error('the case never ran');
      if (lane.outcome.status === 'rejected') throw lane.outcome.reason;
    });
  };
};
