import { describe, expect, test } from 'bun:test';
import type { RunnerLook } from '../../../../contract/index.ts';
import { fixture } from '../../../support/daemon/last-snapshot-stop-fixture.ts';

/** F-0326, the SPEED half: a hanging look never holds a stop for a second. What the stop leaves behind is unit's. */
describe('F-0326 every stop keeps the last screen, masked, before the pane goes', () => {
  test('F-0326 a look that hangs never holds the stop: it completes after the bound in under 1 s', async () => {
    const f = fixture();
    await f.live('never read');
    f.runner.look = async () => await new Promise<RunnerLook | undefined>(() => {});
    const started = Date.now();
    await f.service.stop(f.id, 'now');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
