import { expect, test } from 'bun:test';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

async function running() {
  const f = additivesFixture();
  await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  const handle = f.registry.get(f.id)?.handle;
  if (handle === undefined) throw new Error('the fixture ferret has no handle');
  return { f, handle };
}

test('settleExited: a pane a signal ended settles the ferret stopped, cause signal, with the last lines on both the cause and the journal', async () => {
  const { f, handle } = await running();
  const settled = await f.service.settleExited(
    f.id,
    handle,
    { signal: 9, lastLines: 'Killed' },
    'running',
    async () => true,
  );
  expect(settled).toBe(true);
  const ferret = await f.service.get(f.id);
  expect(ferret?.state).toBe('stopped');
  expect(ferret?.cause).toEqual({ kind: 'signal', signal: 9, lastLines: 'Killed' });
  expect(f.history.at(-1)).toMatchObject({
    type: 'session.exited',
    data: { status: 'failed', pane: 'dead', exitCode: null, signal: 9, from: 'running' },
  });
  expect(String(f.history.at(-1)?.data.reason)).toContain('signal 9');
  expect(String(f.history.at(-1)?.data.reason)).toContain('Killed');
});

test('settleExited: a non-zero exit is agent_crashed with the number', async () => {
  const { f, handle } = await running();
  await f.service.settleExited(f.id, handle, { status: 2 }, 'running', async () => true);
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'agent_crashed', exitCode: 2 });
  expect(f.history.at(-1)?.data).toMatchObject({ status: 'failed', exitCode: 2, signal: null });
});

test('settleExited: exit 0 is a clean_exit, journalled stopped (nothing owes it a revive)', async () => {
  const { f, handle } = await running();
  await f.service.settleExited(f.id, handle, { status: 0 }, 'awaiting_user', async () => true);
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'clean_exit' });
  expect(f.history.at(-1)?.data).toMatchObject({ status: 'stopped', exitCode: 0 });
});

test('settleExited: a pane tmux recorded no end for is terminal_gone, still stopped with a reason', async () => {
  const { f, handle } = await running();
  await f.service.settleExited(f.id, handle, {}, 'running', async () => true);
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'terminal_gone' });
  expect(String(f.history.at(-1)?.data.reason)).toContain('not recorded');
});

test('settleExited: a proof the queue wait made stale (a live pane now on the same handle) answers false and changes nothing', async () => {
  const { f, handle } = await running();
  const before = f.history.length;
  expect(await f.service.settleExited(f.id, handle, { signal: 9 }, 'running', async () => false)).toBe(false);
  expect(
    await f.service.settleExited(f.id, handle, { signal: 9 }, 'running', async () => {
      throw new Error('tmux did not answer');
    }),
  ).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
  expect(f.registry.get(f.id)?.cause).toBeUndefined();
  expect(f.history.length).toBe(before);
});

test('settleExited: another handle (the ferret was relaunched on another pane) changes nothing', async () => {
  const { f } = await running();
  expect(await f.service.settleExited(f.id, '%999', { signal: 9 }, 'running', async () => true)).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('working');
});

test("settleExited: the owner's stop wins: a ferret the owner stopped stays stopped on its own cause and is never rewritten", async () => {
  const { f, handle } = await running();
  await f.service.stop(f.id, 'polite', 'owner asked');
  expect(f.registry.get(f.id)?.cause).toEqual({ kind: 'stopped' });
  const before = f.history.length;
  // The harness that stopped politely left a dead pane: the watch may still find it and ask.
  expect(await f.service.settleExited(f.id, handle, { signal: 2 }, 'running', async () => true)).toBe(false);
  expect(f.registry.get(f.id)?.cause).toEqual({ kind: 'stopped' });
  expect(f.history.length).toBe(before);
});
