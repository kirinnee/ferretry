import { expect, test } from 'bun:test';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

const EXITED = { from: 'running', reason: 'the agent is no longer running: its terminal is gone' };

async function running() {
  const f = additivesFixture();
  await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  const handle = f.registry.get(f.id)?.handle;
  if (handle === undefined) throw new Error('the fixture ferret has no handle');
  return { f, handle };
}

test('settleGone: a proof that still holds inside the queue settles the ferret terminal_gone', async () => {
  const { f, handle } = await running();
  const settled = await f.service.settleGone(f.id, handle, EXITED, async () => true);
  expect(settled).toBe(true);
  expect((await f.service.get(f.id))?.state).toBe('stopped');
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'terminal_gone' });
});

test('settleGone: a proof the queue wait made stale (a live pane now on the same handle) answers false and changes nothing', async () => {
  const { f, handle } = await running();
  // The relaunch that ran while the settle waited put a LIVE pane on the very same pane id: the second ask says so.
  const settled = await f.service.settleGone(f.id, handle, EXITED, async () => false);
  expect(settled).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
  expect(f.registry.get(f.id)?.cause).toBeUndefined();
});

test('settleGone: an ask that cannot be answered is no proof', async () => {
  const { f, handle } = await running();
  const settled = await f.service.settleGone(f.id, handle, EXITED, async () => {
    throw new Error('tmux did not answer');
  });
  expect(settled).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
});
