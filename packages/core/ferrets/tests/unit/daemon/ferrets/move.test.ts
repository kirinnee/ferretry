import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { FakeHarness, ferretId } from '../../../../contract/testing/index.ts';
import { err } from '@ferretry/std';
import { ferretsMoveResume, movedTarget } from '../../../../daemon/lib/ferrets/move-resume.ts';
import { SessionMoveError } from '../../../../daemon/lib/runtime/mounts/session-move.ts';
import { additivesFixture } from './additives-fixture.ts';

const policy = { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true } as const;
/** Where a move onto another runtime of the same harness relaunches (what the moves module recorded). */
const target = async () => ({ runtime: 'claude-two', harness: 'claude-code' as const, conversation: 'conv-fern' });
/** Where a move onto a codex runtime relaunches: its own converted conversation and the model the move planned. */
const codexTarget = async () => ({
  runtime: 'codex-two',
  harness: 'codex' as const,
  conversation: 'codex-conv',
  model: 'gpt-9',
});

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

test('a move relaunches on the TARGET runtime and harness, not the record’s old ones; the old login does not carry', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  expect(f.harness.launched.at(-1)).toMatchObject({ runtime: 'claude-one', login: 'first', harness: 'claude-code' });
  const first = f.harness.launched.length;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  // The launch spec the harness got is the move's target, through the ordinary launch.
  expect(f.codex.launched).toHaveLength(1);
  expect(f.codex.launched[0]).toMatchObject({ runtime: 'codex-two', harness: 'codex' });
  expect(f.codex.launched[0]?.login).toBeUndefined();
  expect(f.harness.launched).toHaveLength(first);
  // Ferrets' record is the one owner of it, and it is what the summary now says.
  expect(f.registry.get(f.id)).toMatchObject({ runtime: 'codex-two', harness: 'codex', state: 'working' });
  expect(f.registry.get(f.id)?.login).toBeUndefined();
});

test('a move asks the start gate about the TARGET, not the old runtime', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  f.asked.length = 0;
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  expect(f.asked).toEqual([{ harness: 'codex', runtime: 'codex-two' }]);
});

test('a move never carries the previous login: the moves module records none, so the target has none', async () => {
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

/** The keys `session-move.ts` restamps onto the session's `config.json` (a stand-in for what it writes). */
const restamp = (extra: Record<string, unknown> = {}) => ({
  agent: 'codex-two',
  harness: 'codex',
  model: 'gpt-9',
  modelHint: 'gpt',
  command: ['codex'],
  incarnation: 'fern-2',
  runtimeGeneration: 2,
  move: { from: 'claude-one', to: 'codex-two', at: '2026-11-07T00:00:00.000Z' },
  moves: [],
  updatedAt: '2026-11-07T00:00:00.000Z',
  ...extra,
});

test('movedTarget reads what the moves module restamps: runtime, harness, model and the recorded conversation', async () => {
  const resumed = await movedTarget(async () =>
    restamp({ transcript: { harness: 'codex', harnessSessionId: 'codex-conv', file: '/x/rollout.jsonl' } }),
  );
  expect(resumed).toEqual({ runtime: 'codex-two', harness: 'codex', model: 'gpt-9', conversation: 'codex-conv' });
  // A fresh conversation drops the transcript record: there is no conversation to resume.
  expect(await movedTarget(async () => restamp())).toEqual({ runtime: 'codex-two', harness: 'codex', model: 'gpt-9' });
  // No login is written by the moves module, and none is read even if a document names one.
  expect(await movedTarget(async () => restamp({ login: 'second' }))).not.toHaveProperty('login');
});

test('a cross-harness move resumes the TARGET’s conversation, not the old harness’s', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  expect(f.registry.get(f.id)?.harnessConversation).toBe(`conv-${f.id}`);
  const resumed: string[] = [];
  const original = f.codex.resume.bind(f.codex);
  f.codex.resume = async (spec, runner, env, conversation) => {
    resumed.push(conversation);
    return await original(spec, runner, env, conversation);
  };
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  expect(resumed).toEqual(['codex-conv']);
  expect(f.codex.launched[0]?.harnessConversation).toBe('codex-conv');
  expect(f.registry.get(f.id)?.harnessConversation).toBe('codex-conv');
});

test('a fresh move starts the target with no conversation and drops the old one from the record', async () => {
  const f = onOldRuntime();
  await f.service.resume(f.id);
  const resumed: string[] = [];
  const original = f.codex.resume.bind(f.codex);
  f.codex.resume = async (spec, runner, env, conversation) => {
    resumed.push(conversation);
    return await original(spec, runner, env, conversation);
  };
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), async () => ({
    runtime: 'codex-two',
    harness: 'codex' as const,
  }));
  await resume.resume({ id: f.id as never, policy });
  expect(resumed).toEqual([]);
  expect(f.codex.launched).toHaveLength(1);
  expect(f.codex.launched[0]?.harnessConversation).toBeUndefined();
  // The new harness's start named its own conversation; it is never the old harness's one.
  expect(f.registry.get(f.id)?.harnessConversation).toBe(`conv-${f.id}`);
});

test('the move’s model is the launch spec’s model, and the start options keep it', async () => {
  const f = onOldRuntime();
  f.registry.putDetails(f.id, { options: { model: 'old-model', effort: 'high' } });
  await f.service.resume(f.id);
  expect(f.harness.launched.at(-1)).toMatchObject({ model: 'old-model' });
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await resume.resume({ id: f.id as never, policy });
  expect(f.codex.launched[0]).toMatchObject({ model: 'gpt-9', effort: 'high' });
  expect(f.registry.detailsOf(f.id)?.options).toEqual({ model: 'gpt-9', effort: 'high' });
});

test('a failed move relaunch puts the ferret record back as the move found it, as the moves module does its document', async () => {
  const f = onOldRuntime();
  f.registry.putDetails(f.id, { options: { model: 'old-model' } });
  await f.service.resume(f.id);
  f.codex.start = async () => err('failed' as never);
  f.codex.resume = async () => err('failed' as never);
  const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), codexTarget);
  await expect(resume.resume({ id: f.id as never, policy })).rejects.toThrow();
  const after = f.registry.get(f.id)!;
  expect(after).toMatchObject({
    state: 'stopped',
    harness: 'claude-code',
    runtime: 'claude-one',
    login: 'first',
    harnessConversation: `conv-${f.id}`,
  });
  expect(f.registry.detailsOf(f.id)?.options?.model).toBe('old-model');
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
