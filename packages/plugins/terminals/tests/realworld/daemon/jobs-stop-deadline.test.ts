// Realworld: asserts how long `fy job stop` takes on a real tmux with a slow host; the number depends on the machine's
// scheduler and process-launch speed, not only on the code.
import { afterEach, describe, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import should from 'should';
import type { Keeper } from '../../integration/daemon/support/job-keeper.ts';
import { stopThreeDeepTree } from '../../integration/daemon/support/job-tree.ts';

const kept: Keeper[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const one of kept.splice(0)) await one.dispose();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('the job stop deadline on a slow host', () => {
  it('should end a 3-deep TERM/HUP-ignoring tree at the wrapper KILL deadline (about 5.2 s), well before the 9 s fallback', async () => {
    // Act
    const stop = await stopThreeDeepTree(kept, homes);

    // Assert: the wrapper starts its 5 s KILL clock at the TERM; the service waits 9 s before it acts itself.
    should(stop.stoppedState).equal('exited');
    should(stop.tookMs).be.below(7_000);
    should(stop.aliveAfter).deepEqual([]);
  }, 40_000);
});
