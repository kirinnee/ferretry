import { expect, test } from 'bun:test';
import { PERSON_ORIGIN, type FerretId, type RunnerHandle } from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * A record whose runner handle is a pane id that now belongs to ANOTHER ferret: a converted v4 ferret's `%N`, or one from
 * before a tmux server restart (pane ids start again at `%0`). Stopping or replacing "its" pane through that handle used
 * to end the other ferret, and every relaunch that followed ended the next one: a cascade of `working` ferrets with no pane.
 */
function staleHandleFixture() {
  const f = additivesFixture();
  const other = ferretId('oak') as FerretId;
  // `oak` is live on a pane; `fern`'s record kept that very handle, and has no pane of its own.
  const handle: RunnerHandle = f.runner.adoptable(other);
  const record = f.registry.get(f.id);
  if (record === undefined) throw new Error('the fixture ferret is missing');
  f.registry.put({ ...record, state: 'working', handle });
  return { f, handle };
}

test('stop: a ferret whose own terminal is gone does not end the ferret its stale handle now names', async () => {
  const { f, handle } = staleHandleFixture();

  await f.service.stop(f.id, 'now', 'owner stop');

  expect(await f.runner.alive(handle)).toBe(true);
  expect(f.registry.get(f.id)?.state).toBe('stopped');
});

test('a restart (replaceLiveTerminal) of such a ferret relaunches it and leaves the other ferret alone', async () => {
  const { f, handle } = staleHandleFixture();

  const resumed = await f.service.resume(f.id, undefined, {
    actor: 'daemon',
    origin: PERSON_ORIGIN,
    replaceLiveTerminal: true,
  });

  expect(resumed.ok).toBe(true);
  expect(await f.runner.alive(handle)).toBe(true);
  expect(f.registry.get(f.id)?.handle).not.toBe(handle);
});

test('even when nothing proves the terminal gone, the runner is told whose pane it may stop', async () => {
  const { f, handle } = staleHandleFixture();
  f.runner.goneAnswer = false;

  await f.service.stop(f.id, 'now', 'owner stop');

  expect(await f.runner.alive(handle)).toBe(true);
});

/**
 * The 5.0 switch hands a LIVE v4 ferret over by its pane handle on the same tmux server (`FakeRunner.adoptable`: a process
 * already running before this daemon). Its session is `fy-<id>`, the ferret's own, so the guard must let a stop or a
 * restart act on it exactly as before.
 */
function adoptedFixture() {
  const f = additivesFixture();
  const handle: RunnerHandle = f.runner.adoptable(f.id);
  const record = f.registry.get(f.id);
  if (record === undefined) throw new Error('the fixture ferret is missing');
  f.registry.put({ ...record, state: 'working', handle });
  return { f, handle };
}

test('an adopted live v4 pane is still stopped by its own ferret’s stop', async () => {
  const { f, handle } = adoptedFixture();

  await f.service.stop(f.id, 'now', 'owner stop');

  expect(await f.runner.alive(handle)).toBe(false);
  expect(f.registry.get(f.id)?.state).toBe('stopped');
});

test('an adopted live v4 pane is still replaced by its own ferret’s restart', async () => {
  const { f, handle } = adoptedFixture();

  const resumed = await f.service.resume(f.id, undefined, {
    actor: 'daemon',
    origin: PERSON_ORIGIN,
    replaceLiveTerminal: true,
  });

  expect(resumed.ok).toBe(true);
  expect(await f.runner.alive(handle)).toBe(false);
  const relaunched = f.registry.get(f.id)?.handle;
  expect(relaunched).not.toBe(handle);
  expect(await f.runner.alive(relaunched as RunnerHandle)).toBe(true);
});
