import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { FakeHarness, ferretId } from '../../../../contract/testing/index.ts';
import { ferretsMoveResume } from '../../../../daemon/lib/ferrets/move-resume.ts';
import { SessionMoveError } from '../../../../daemon/lib/runtime/mounts/session-move.ts';
import { additivesFixture } from './additives-fixture.ts';

const policy = { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true } as const;
/** Where a move onto another runtime of the same harness relaunches (what the moves module recorded). */
const target = async () => ({ runtime: 'claude-two', harness: 'claude-code' as const, login: 'second' });
/** Where a move onto a codex runtime relaunches. */
const codexTarget = async () => ({ runtime: 'codex-two', harness: 'codex' as const, login: 'second' });

test('S42 a move relaunches through the ordinary launch: the harness names the home, prepareHome runs, a new token is issued', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
  const outcome = await resume.resume({ id: f.id as never, policy });
  expect(outcome.disposition).toBe('revived');
  // The OLD pane is gone and a NEW one runs: never two panes for one ferret.
  expect(await f.runner.alive(before)).toBe(false);
  const after = (await f.service.handle(f.id))!;
  expect(after).not.toBe(before);
  expect(await f.runner.alive(after)).toBe(true);
  expect(f.runner.starts).toBe(2);
  // Every launch spec is Ferrets' own: the home is the harness's answer, prepared before the runner was asked.
  expect(f.harness.prepared).toHaveLength(2);
  for (const spec of f.harness.launched) expect(spec.home).toBe(await f.harness.homeFor(f.id));
  expect(f.tokens.holds(f.id)).toBe(true);
});

test('S42 a move whose launch is refused (shared home) throws a refusal and leaves no second pane', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  f.harness.homeFor = async () => '/home/agent-homes/../shared' as never;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
  await expect(resume.resume({ id: f.id as never, policy })).rejects.toThrow();
  expect(f.runner.starts).toBe(1);
});

test('move(ferret, runtime) hands the runtime to the moves flow and answers the ferret’s summary', async () => {
  const f = additivesFixture();
  const seen: unknown[] = [];
  f.ports.move = async (ferret, runtime, options) => {
    seen.push({ ferret, runtime, options });
  };
  const moved = await f.service.move(f.id, 'codex-two', { model: 'gpt', movedBy: 'owner' });
  expect(seen).toEqual([{ ferret: f.id, runtime: 'codex-two', options: { model: 'gpt', movedBy: 'owner' } }]);
  expect(moved.ok && moved.value.id).toBe(f.id);
});

test('a refused move answers its own code and sentence; an unbuilt part answers plugin_unavailable', async () => {
  const f = additivesFixture();
  f.ports.move = async () => {
    throw new SessionMoveError('harness_mismatch', 'a move stays on the same kind of harness');
  };
  expect(await f.service.move(f.id, 'codex')).toEqual({
    ok: false,
    error: { code: 'harness_mismatch', reason: 'a move stays on the same kind of harness' },
  });
  f.ports.move = async () => {
    throw new ApiError(503, 'The account inventory is not built yet.', 'plugin_unavailable');
  };
  expect(await f.service.move(f.id, 'codex')).toEqual({
    ok: false,
    error: { code: 'plugin_unavailable', reason: 'The account inventory is not built yet.' },
  });
  delete f.ports.move;
  const unbound = await f.service.move(f.id, 'codex');
  expect(!unbound.ok && unbound.error.code).toBe('plugin_unavailable');
  expect(await f.service.move(ferretId('nobody'), 'codex')).toMatchObject({ ok: false, error: { code: 'not_found' } });
});

test('a ferret moves only itself and its helpers, as stop and resume', async () => {
  const f = additivesFixture();
  f.ports.move = async () => {};
  const base = f.registry.get(f.id)!;
  const stranger = ferretId('stranger');
  f.registry.put({ ...base, id: stranger, name: 'stranger' });
  await expect(f.service.move(f.id, 'codex', {}, stranger)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect((await f.service.move(f.id, 'codex', {}, f.id)).ok).toBe(true);
});

/** A service with two harnesses, as a move onto another runtime needs, and a ferret on its OLD runtime. */
function onOldRuntime() {
  const f = additivesFixture();
  const codex = new FakeHarness('codex', '/home/codex-homes');
  f.ports.harness = key => (key === 'codex' ? codex : f.harness);
  f.ports.harnessKeys = () => ['claude-code', 'codex'];
  f.registry.put({ ...f.registry.get(f.id)!, runtime: 'claude-one', login: 'first' });
  const asked: { harness: string; runtime?: string; login?: string }[] = [];
  f.ports.decide = async input => {
    asked.push({
      harness: input.harness,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.login === undefined ? {} : { login: input.login }),
    });
    return { allow: true };
  };
  return { ...f, codex, asked };
}

test('a move relaunches on the TARGET runtime, login and harness, not the record’s old ones', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  expect(f.harness.launched.at(-1)).toMatchObject({ runtime: 'claude-one', login: 'first', harness: 'claude-code' });
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  // The launch spec the harness got is the move's target, through the ordinary launch.
  expect(f.codex.launched).toHaveLength(1);
  expect(f.codex.launched[0]).toMatchObject({ runtime: 'codex-two', login: 'second', harness: 'codex' });
  expect(f.harness.launched).toHaveLength(1);
  // Ferrets' record is the one owner of it, and it is what the summary now says.
  expect(f.registry.get(f.id)).toMatchObject({ runtime: 'codex-two', login: 'second', harness: 'codex', state: 'working' });
});

test('a move asks the start gate about the TARGET, not the old runtime', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  f.asked.length = 0;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  expect(f.asked).toEqual([{ harness: 'codex', runtime: 'codex-two', login: 'second' }]);
});

test('a move onto a target with no login does not keep the previous login', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), async () => ({
    runtime: 'codex-two',
    harness: 'codex' as const,
  }));
  await resume.resume({ id: f.id as never, policy });
  expect(f.registry.get(f.id)?.login).toBeUndefined();
  expect(f.codex.launched[0]?.login).toBeUndefined();
});

test('a move whose recorded target cannot be read back refuses before anything is stopped', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), async () => {
    throw new Error('unreadable');
  });
  await expect(resume.resume({ id: f.id as never, policy })).rejects.toThrow();
  expect(await f.service.handle(f.id)).toBe(before);
  expect(f.registry.get(f.id)).toMatchObject({ state: 'working', runtime: 'claude-one' });
});

test('a move whose target is not a runtime Ferrets can record is refused and leaves the ferret working', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const outcome = await f.service.resume(f.id, undefined, {
    replaceLiveTerminal: true,
    target: { runtime: 'Not A Runtime!', harness: 'codex' },
  });
  expect(outcome.ok).toBe(false);
  expect(await f.service.handle(f.id)).toBe(before);
  expect(f.registry.get(f.id)?.state).toBe('working');
});
