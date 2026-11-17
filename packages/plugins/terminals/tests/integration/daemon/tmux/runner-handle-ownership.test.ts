/**
 * Every runner call made THROUGH a pane handle for a ferret. A pane id is not an identity: after a tmux-server restart (or
 * from a converted v4 record) `%7` can name ANOTHER ferret's pane, and a message typed, a key pressed or a screen read through
 * it would reach that ferret. The pane here is `fy-f-hadi`'s; `f-stale` is the ferret whose record kept the handle.
 */
import { describe, expect, it } from 'bun:test';
import { type FerretId, runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import { PaneNotReadyError } from '../../../../daemon/adapters/tmux/pane-delivery.ts';
import { subject } from './runner-world.ts';

const OWNER = 'f-hadi' as FerretId;
const STALE = 'f-stale' as FerretId;
const STOP = { key: 'Escape', whenIdle: true } as const;

/** What a refused write looks like: a `not_ready`/`exited` rejection, and nothing at all reached tmux or the kernel's act. */
async function refused(write: () => Promise<unknown>, world: ReturnType<typeof subject>): Promise<void> {
  const error = await write().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PaneNotReadyError);
  expect(runnerDeliveryFailure(error)).toEqual({ kind: 'not_ready', why: 'exited' });
  expect(world.server.calls).toEqual([]);
  expect(world.acts).toEqual([]);
  expect(world.server.submitted).toEqual([]);
  expect(world.server.composer).toBe('');
}

describe('tmux runner calls through a handle that names another ferret’s pane', () => {
  it('does not type a send into it, and does not queue one', async () => {
    const world = subject();
    await refused(() => world.runner.deliver(world.handle, { text: 'for f-stale' }, STALE), world);
    await refused(() => world.runner.queue(world.handle, 'for f-stale', STALE), world);
  });

  it('does not press the interrupt key on its turn', async () => {
    const world = subject();
    await refused(() => world.runner.stopTurn(world.handle, STOP, STALE), world);
    await refused(() => world.runner.stopActiveTurn(world.handle, STOP, STALE), world);
  });

  it('does not touch its composer, its question form or its model picker', async () => {
    const world = subject();
    await refused(() => world.runner.clearComposer(world.handle, 'x', STALE), world);
    await refused(() => world.runner.submitComposer(world.handle, 'x', false, STALE), world);
    await refused(() => world.runner.formKey(world.handle, 'Enter', STALE), world);
    await refused(() => world.runner.pickerKey(world.handle, '1', STALE), world);
    await refused(() => world.runner.formPaste(world.handle, 'x', STALE), world);
  });

  it('waits on nothing and reads nothing of it', async () => {
    const world = subject();
    await refused(() => world.runner.settled(world.handle, STALE), world);
    expect(await world.runner.observe(world.handle, STALE)).toBeUndefined();
    await expect(world.runner.heldAt(world.handle, 'x', STALE)).rejects.toBeInstanceOf(PaneNotReadyError);
    expect(await world.runner.lastScreen(world.handle, STALE)).toBe('');
    expect(await world.runner.formCapture(world.handle, STALE)).toBeUndefined();
    expect(world.server.calls.filter(call => call[0] === 'capture-pane')).toEqual([]);
  });

  it('does not count its life as the stale ferret’s', async () => {
    const world = subject();
    expect(await world.runner.alive(world.handle, STALE)).toBe(false);
    expect(await world.runner.alive(world.handle, OWNER)).toBe(true);
  });
});

describe('the same calls for the pane’s own ferret (an adopted v4 pane has the same session name)', () => {
  it('still deliver, observe and stop its turn', async () => {
    const world = subject();

    expect(await world.runner.deliver(world.handle, { text: 'one send' }, OWNER)).toBe('turn-started');
    expect(world.server.submitted).toEqual(['one send']);
    expect(await world.runner.observe(world.handle, OWNER)).toBeDefined();
    expect(await world.runner.lastScreen(world.handle, OWNER)).not.toBe('x-never');
    expect(await world.runner.stopTurn(world.handle, STOP, OWNER)).toMatchObject({ pressed: expect.any(Boolean) });
  });

  it('trust the handle alone when no ferret is named (a launch that has just made the pane)', async () => {
    const world = subject();

    expect(await world.runner.deliver(world.handle, { text: 'one send' })).toBe('turn-started');
  });
});
