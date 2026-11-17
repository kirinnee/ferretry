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

/** A converted v4 ferret: live in the registry (`working`/`idle`) with NO handle, because a handle without proof was dropped. */
async function handleless(state: 'working' | 'idle' = 'working') {
  const { f } = await running();
  const held = f.registry.get(f.id);
  if (held === undefined) throw new Error('the fixture ferret is not held');
  const { handle: _dropped, ...rest } = held;
  f.registry.put({ ...rest, state });
  return f;
}

test('settleGone: a handle-less working ferret is settled terminal_gone when the expected handle is none', async () => {
  const f = await handleless('working');
  expect(f.registry.get(f.id)?.handle).toBeUndefined();
  expect(await f.service.settleGone(f.id, undefined, EXITED, async () => true)).toBe(true);
  expect((await f.service.get(f.id))?.state).toBe('stopped');
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'terminal_gone' });
});

test('settleGone: a handle-less idle ferret is settled terminal_gone too', async () => {
  const f = await handleless('idle');
  expect(await f.service.settleGone(f.id, undefined, EXITED)).toBe(true);
  expect((await f.service.get(f.id))?.state).toBe('stopped');
});

test('settleGone: a ferret that gained a handle since it was observed handle-less is NOT settled (a relaunch won)', async () => {
  const { f, handle } = await running();
  expect(f.registry.get(f.id)?.handle).toBe(handle);
  expect(await f.service.settleGone(f.id, undefined, EXITED, async () => true)).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
  expect(f.registry.get(f.id)?.cause).toBeUndefined();
});

test('settleGone: a handle-less ferret is not settled on a handle it never held, nor once its proof went stale', async () => {
  const f = await handleless('working');
  expect(await f.service.settleGone(f.id, '%9', EXITED, async () => true)).toBe(false);
  expect(await f.service.settleGone(f.id, undefined, EXITED, async () => false)).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
});

test('settleGone: the second notice of the same vanished terminal (the sweep and a failed look) writes one session.exited, once', async () => {
  const { f, handle } = await running();
  const exits = () => f.history.filter(line => line.type === 'session.exited').length;
  const before = exits();

  // Both observers proved it gone and both reach the ferret's queue: the first lands, the second finds it stopped.
  const first = f.service.settleGone(f.id, handle, EXITED, async () => true);
  const second = f.service.settleGone(f.id, handle, EXITED, async () => true);

  expect([await first, await second]).toEqual([true, false]);
  expect(exits() - before).toBe(1);
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'terminal_gone' });
});
