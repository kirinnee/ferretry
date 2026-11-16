/**
 * c58-37 PR2: RESTART CLI on a 5.0 ferret (`POST /v1/ferrets/:ferretId/move` naming the runtime the ferret is already on),
 * through the real moves module over the registry's record, the runner's pane and the ferret's own session documents. The
 * v4 contracts these hold are `boot-lifecycle.test.ts`' gate-refuses, restart-on-current-settings and resume-the-bound-
 * conversation cases, now with a ferret's pane reached by its handle instead of a tmux session name.
 */
import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import {
  PERSON_ORIGIN,
  type FerretId,
  FerretsPort,
  RUNTIME_START_KEY,
  RuntimeStart,
  FerretConfigFile,
  FerretStateFile,
  type RunnerHandle,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { fakeLogins, fakeRuntimeStartAnswer, host } from './route-fixture.ts';

const RUNTIME = 'claude-main';

const runtimes = implementDaemon(
  definePlugin({
    id: 'runtimes',
    title: 'Runtimes (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
  }),
  { build: () => ({ hooks: { 'runtime.start:runtimes': fakeRuntimeStartAnswer } }) },
);

/** A ferret STARTED on `RUNTIME` (so its record, its session documents and its pane are the ones a start makes). */
async function boot(options: { readonly runner?: FakeRunner } = {}) {
  const runner = options.runner ?? new FakeRunner();
  const harness = new FakeHarness();
  // `ps` answers an empty table: the pane's process tree holds nothing, so the gate has no work to protect.
  const spawn = async () => ({ exitCode: 0, signal: null, stdout: 'PID PPID ELAPSED ARGS\n', stderr: '' });
  const h = await host([], { harness, runner, spawn, plugins: [runtimes, fakeLogins()] });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'start-one' },
    body: { folder: '/work/lead', name: 'lead', runtime: RUNTIME },
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: FerretId }>().id;
  await h.settle();
  // The runner numbers its panes from %1, so a ferret's first (and only) pane is this one.
  const handle = '%1';
  // The agent is at its prompt: a ferret that says it is WORKING with nothing visible is refused, as in v4.
  const state = h.state('ferrets');
  state.plant(
    FerretStateFile,
    (state.raw(FerretStateFile, id) ?? '').replace('"status":"running"', '"status":"awaiting_user"'),
    id,
  );
  runner.starts = 0;
  const launches = harness.launched.length;
  return { h, runner, harness, id, handle: handle as RunnerHandle, launches };
}

const restart = async (h: TestHost, id: string, body: Record<string, unknown> = {}) =>
  await h.request('POST', `/v1/ferrets/${id}/move`, {
    headers: { 'x-fy-request-id': `restart-${Math.random()}` },
    body: { agent: RUNTIME, ...body },
  });

describe('Restart CLI on a 5.0 ferret', () => {
  test('a ferret on a runtime restarts on it: the old pane is replaced by one resuming the same conversation', async () => {
    const { h, runner, harness, id, handle } = await boot();

    const answer = await restart(h, id, { forceInflight: false });

    expect(answer.status).toBe(200);
    expect(await runner.alive(handle)).toBe(false);
    expect(runner.starts).toBe(1);
    expect(harness.launched.at(-1)?.ferret).toBe(id);
    await h.stop();
  });

  test('a runner that cannot identify the pane is a blind spot: the Restart is refused, and Restart anyway goes through', async () => {
    const runner = new FakeRunner();
    runner.identity = undefined;
    const { h, harness, id, launches } = await boot({ runner });

    const refused = await restart(h, id);
    expect(refused.status).toBe(409);
    expect(runner.starts).toBe(0);
    expect(harness.launched).toHaveLength(launches);

    const forced = await restart(h, id, { forceInflight: true });
    expect(forced.status).toBe(200);
    expect(runner.starts).toBe(1);
    await h.stop();
  });

  test('a refused Restart leaves the ferret’s documents byte-identical', async () => {
    const runner = new FakeRunner();
    runner.identity = undefined;
    const { h, id } = await boot({ runner });
    const read = async () => (await h.request('GET', `/v1/ferrets/${id}`, {})).body;
    const documents = async () => [
      h.state('ferrets').raw(FerretConfigFile, id),
      h.state('ferrets').raw(FerretStateFile, id),
    ];
    const before = [await read(), ...(await documents())];

    const refused = await restart(h, id);

    expect(refused.status).toBe(409);
    expect([await read(), ...(await documents())]).toEqual(before);
    await h.stop();
  });

  test('a pane replaced between the gate and the kill refuses with nothing launched (the expected handle)', async () => {
    const { h, runner, id, handle } = await boot();
    // Another relaunch lands while the gate looks: the registry's handle for the ferret is no longer the pane the gate judged.
    const ferrets = h.provided(FerretsPort);
    const original = runner.identify.bind(runner);
    let raced = false;
    runner.identify = async handleOf => {
      const found = await original(handleOf);
      if (!raced) {
        raced = true;
        await ferrets.stop(id, 'now');
        await ferrets.resume(id, undefined, { origin: PERSON_ORIGIN });
      }
      return found;
    };

    const answer = await restart(h, id);

    expect(answer.status).toBe(409);
    expect(answer.json<{ error: string }>().error).toContain('no longer owed this resume');
    // Only the competing relaunch started a pane: the Restart's own kill and launch never ran against the new one.
    expect(runner.starts).toBe(1);
    expect(await runner.alive(handle)).toBe(false);
    await h.stop();
  });

  test('going back to the earlier conversation is refused (not built yet) before any write or kill: documents byte-identical, pane untouched', async () => {
    const { h, runner, harness, id, handle, launches } = await boot();
    // The owner's own history holds a newer conversation: the finder this must never read (it lists the owner's ~/.claude).
    let listed = 0;
    harness.conversations.list = async () => {
      listed += 1;
      return [{ id: 'owner-newest', updatedAt: '2099-01-01T00:00:00.000Z' }] as never;
    };
    const documents = async () => [
      h.state('ferrets').raw(FerretConfigFile, id),
      h.state('ferrets').raw(FerretStateFile, id),
    ];
    const before = await documents();

    const answer = await restart(h, id, { conversation: 'previous' });

    // `unavailable`, as `convert` is refused: 503 agent_unavailable, never the 409 that offers "Start fresh".
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('agent_unavailable');
    expect(answer.json<{ error: string }>().error).toContain('not built yet');
    expect(await documents()).toEqual(before);
    expect(await runner.alive(handle)).toBe(true);
    expect(runner.starts).toBe(0);
    expect(harness.launched).toHaveLength(launches);
    expect(listed).toBe(0);
    await h.stop();
  });

  test('another runtime still answers that it is not built yet', async () => {
    const { h } = await boot();

    const answer = await h.request('POST', '/v1/ferrets/lead/move', {
      headers: { 'x-fy-request-id': 'other' },
      body: { agent: 'codex-two' },
    });

    expect(answer.status).toBeGreaterThanOrEqual(400);
    await h.stop();
  });
});
