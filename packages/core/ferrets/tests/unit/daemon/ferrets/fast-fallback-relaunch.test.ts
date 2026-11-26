/**
 * E-266 round 3: what a RELAUNCH says when fast mode can no longer be verified.
 *
 *  - the app's Restart (`POST /v1/ferrets/:ferretId/move` naming the ferret's own runtime) carries the notice in the
 *    response it gets, not only in the saved details;
 *  - a Claude Code relaunch whose model cannot serve fast mode (`unservable_model`) is exactly what it was before
 *    E-266: fast dropped from the options, no notice, no explicit `fast: false`.
 */
import { expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import {
  FerretStateFile,
  RUNTIME_START_KEY,
  RuntimeStart,
  StartDecide,
  type StartDecideInput,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import restartResponse from '../../../fixtures/restart-downgrade-response.json' with { type: 'json' };
import { fakeLogins, fakeRuntimeStartAnswer, host } from './route-fixture.ts';

const RUNTIME = 'codex-main';
const NOTICE = 'Started without Fast: Codex’s model list is still loading; try again in a few seconds';

type Verdict = 'ok' | 'fast_unverified' | 'unservable_model';

const world = async () => {
  const verdict: { now: Verdict } = { now: 'ok' };
  const taker = implementDaemon(
    definePlugin({
      id: 'codex',
      title: 'Fast fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: StartDecide }] },
    }),
    {
      build: () => ({
        hooks: {
          'start.decide': (input: StartDecideInput) =>
            input.fast !== true || verdict.now === 'ok'
              ? { allow: true }
              : {
                  allow: false,
                  code: verdict.now,
                  reason: verdict.now === 'fast_unverified' ? NOTICE : 'claude-sonnet-5-5 has no fast mode',
                },
        },
      }),
    },
  );
  const runtimes = implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtime fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': fakeRuntimeStartAnswer } }) },
  );
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  // `ps` answers an empty table: the pane holds no work the Restart gate has to protect.
  const spawn = async () => ({ exitCode: 0, signal: null, stdout: 'PID PPID ELAPSED ARGS\n', stderr: '' });
  const h = await host([], { harness, runner, spawn, plugins: [taker, runtimes, fakeLogins()] });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'start-one' },
    body: { folder: '/work/lead', name: 'lead', runtime: RUNTIME, model: 'model-x', fast: true },
  });
  expect(started.status).toBe(201);
  const { id } = started.json<{ id: string }>();
  await h.settle();
  const state = h.state('ferrets');
  state.plant(
    FerretStateFile,
    (state.raw(FerretStateFile, id) ?? '').replace('"status":"running"', '"status":"awaiting_user"'),
    id,
  );
  expect(harness.launched.at(-1)?.options?.fast).toBe(true);
  return { h, harness, verdict, id };
};

const restart = async (h: Awaited<ReturnType<typeof world>>['h'], id: string) =>
  await h.request('POST', `/v1/ferrets/${id}/move`, {
    headers: { 'x-fy-request-id': `restart-${Math.random()}` },
    body: { agent: RUNTIME },
  });

test('E-266 R3 the app Restart response carries the downgrade notice the daemon saved', async () => {
  const { h, harness, verdict, id } = await world();
  verdict.now = 'fast_unverified';
  const answer = await restart(h, id);
  expect(answer.status).toBe(200);
  expect(answer.json<{ id: string; notice?: string }>()).toMatchObject({ id, notice: NOTICE });
  // The browser scene replays THIS answer (the ids aside), so the app is shown what the daemon really sends.
  expect({ ...answer.json<object>(), id: 'wren' }).toEqual(restartResponse);
  expect(harness.launched.at(-1)?.options?.fast).toBe(false);
  await h.stop();
});

test('E-266 R3 a Restart that did not downgrade answers no notice', async () => {
  const { h, id } = await world();
  const answer = await restart(h, id);
  expect(answer.status).toBe(200);
  expect(answer.json<{ notice?: string }>().notice).toBeUndefined();
  await h.stop();
});

test('E-266 R3 an unservable_model relaunch (Claude on Sonnet) drops fast with no notice and no explicit fast false', async () => {
  const { h, harness, verdict, id } = await world();
  verdict.now = 'unservable_model';
  const restarted = await restart(h, id);
  expect(restarted.status).toBe(200);
  expect(restarted.json<{ notice?: string }>().notice).toBeUndefined();
  expect(harness.launched.at(-1)?.options).not.toHaveProperty('fast');
  await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
  const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });
  expect(resumed.status).toBe(200);
  expect(resumed.json<{ notice?: string }>().notice).toBeUndefined();
  expect(harness.launched.at(-1)?.options).not.toHaveProperty('fast');
  const read = (await h.request('GET', `/v1/ferrets/${id}`)).json<{ notice?: string; fast?: boolean }>();
  expect(read.notice).toBeUndefined();
  expect(read.fast).not.toBe(false);
  await h.stop();
});
