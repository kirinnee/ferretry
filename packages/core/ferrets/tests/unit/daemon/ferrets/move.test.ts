import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ferretsMoveResume } from '../../../../daemon/lib/ferrets/move-resume.ts';
import { SessionMoveError } from '../../../../daemon/lib/runtime/mounts/session-move.ts';
import { additivesFixture } from './additives-fixture.ts';

const policy = { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true } as const;

test('S42 R-0355 a move relaunches through the ordinary launch: the harness names the home, prepareHome runs, a new token is issued', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret));
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
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret));
  await expect(resume.resume({ id: f.id as never, policy })).rejects.toThrow();
  expect(f.runner.starts).toBe(1);
});

test('R-0355 move(ferret, runtime) hands the runtime to the moves flow and answers the ferret’s summary', async () => {
  const f = additivesFixture();
  const seen: unknown[] = [];
  f.ports.move = async (ferret, runtime, options) => {
    seen.push({ ferret, runtime, options });
  };
  const moved = await f.service.move(f.id, 'codex-two', { model: 'gpt', movedBy: 'owner' });
  expect(seen).toEqual([{ ferret: f.id, runtime: 'codex-two', options: { model: 'gpt', movedBy: 'owner' } }]);
  expect(moved.ok && moved.value.id).toBe(f.id);
});

test('R-0355 a refused move answers its own code and sentence; an unbuilt part answers plugin_unavailable', async () => {
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

test('R-0355 a ferret moves only itself and its helpers, as stop and resume', async () => {
  const f = additivesFixture();
  f.ports.move = async () => {};
  const base = f.registry.get(f.id)!;
  const stranger = ferretId('stranger');
  f.registry.put({ ...base, id: stranger, name: 'stranger' });
  await expect(f.service.move(f.id, 'codex', {}, stranger)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  expect((await f.service.move(f.id, 'codex', {}, f.id)).ok).toBe(true);
});
