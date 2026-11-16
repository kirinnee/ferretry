/**
 * c58-37 PR6: MOVE A FERRET ONTO ANOTHER LOGIN of the same harness (`POST /v1/ferrets/:ferretId/move` naming another runtime),
 * through the real moves module over the registry's record, the runner's pane and the ferret's own session documents.
 *
 * The v4 contracts these hold are `boot-lifecycle.test.ts`' migrate half (the same-family refusal and its ordering, the
 * smaller-window refusal, the gate, "a clean pane migrates", the bound conversation going WITH the session) and
 * `session-migrate.test.ts`' refusal taxonomy, now with the ferret's own harness home (the conversation never leaves it)
 * and Runtimes' `runtime.start` (`resolve` + `catalog?`) deciding what the target serves.
 *
 * Every refusal is held to the same bar as the v4 ones: it leaves `ferret.json`, `config.json` and `state.json`
 * byte-identical, and the live pane untouched.
 */
import { describe, expect, test } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { err, ok } from '@ferretry/std';
import {
  type FerretId,
  FerretConfigFile,
  FerretFiles,
  FerretStateFile,
  RUNTIME_START_KEY,
  RuntimeStart,
  type RuntimeStartResolution,
  type RuntimeStartSource,
} from '../../../../contract/index.ts';
import type { RuntimeModelCatalog } from '../../../../contract/view/runtime-control.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { fakeLogins, host } from './route-fixture.ts';

const MAIN = 'claude-main';
const TWO = 'claude-two';
const CODEX = 'codex-main';
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

const choice = (value: string, context: number, isDefault = false, efforts = ['low', 'high']) => ({
  value,
  label: value,
  context,
  ...(isDefault ? { isDefault: true as const } : {}),
  reasoningEfforts: efforts.map(effort => ({ value: effort })),
});
const catalog = (
  harness: 'claude' | 'codex',
  choices: RuntimeModelCatalog['choices'],
  customIds = false,
): RuntimeModelCatalog => ({
  harness,
  source: 'wrapper-inventory',
  choices,
  catalog: { id: 'models', label: 'Models', customIds },
});

/** What each published runtime serves; a runtime NOT here does not exist. `claude-two` has a SMALLER window for opus. */
const CATALOGS: Record<string, RuntimeModelCatalog> = {
  [MAIN]: catalog('claude', [choice(OPUS, 1_000_000), choice(SONNET, 200_000, true)]),
  [TWO]: catalog('claude', [choice(OPUS, 200_000), choice(SONNET, 200_000, true)]),
  'claude-big': catalog('claude', [choice(OPUS, 1_000_000, true), choice(SONNET, 1_000_000)]),
  'claude-bare': { harness: 'claude', source: 'wrapper-inventory', choices: [] },
  [CODEX]: catalog('codex', [choice('gpt-9', 400_000, true)]),
};
const LOGINS: Record<string, string> = { [MAIN]: 'login-main', [TWO]: 'login-two', 'claude-big': 'login-big' };

interface Source extends RuntimeStartSource {
  resolved: string[];
}

const runtimeSource = (options: { readonly catalog?: boolean } = {}): Source => {
  const source: Source = {
    resolved: [],
    login: async () => ({ ok: true }),
    resolve: async (runtime): Promise<RuntimeStartResolution> => {
      source.resolved.push(runtime);
      const found = CATALOGS[runtime];
      if (found === undefined) return { ok: false, sentence: `there is no runtime named ${runtime}` };
      return {
        ok: true,
        harness: found.harness === 'codex' ? 'codex' : 'claude-code',
        login: LOGINS[runtime] ?? 'login-other',
      };
    },
    ...(options.catalog === false ? {} : { catalog: async (runtime: string) => CATALOGS[runtime] }),
  };
  return source;
};

const runtimesPlugin = (source: RuntimeStartSource) =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': source } }) },
  );

/** The agent is at its prompt: a ferret that says it is WORKING with nothing visible is refused, as in v4. */
function atPrompt(h: TestHost, id: string): void {
  const state = h.state('ferrets');
  state.plant(
    FerretStateFile,
    (state.raw(FerretStateFile, id) ?? '').replace(/"status":"[a-z_]+"/u, '"status":"awaiting_user"'),
    id,
  );
}

/** A ferret STARTED on `MAIN` (so its record, its session documents and its pane are the ones a start makes), at its prompt. */
async function boot(
  options: {
    readonly runner?: FakeRunner;
    readonly harness?: FakeHarness;
    readonly source?: Source;
    readonly start?: Record<string, unknown>;
  } = {},
) {
  const runner = options.runner ?? new FakeRunner();
  const harness = options.harness ?? new FakeHarness();
  const source = options.source ?? runtimeSource();
  // `ps` answers an empty table: the pane's process tree holds nothing, so the gate has no work to protect.
  const spawn = async () => ({ exitCode: 0, signal: null, stdout: 'PID PPID ELAPSED ARGS\n', stderr: '' });
  const h = await host([], { harness, runner, spawn, plugins: [runtimesPlugin(source), fakeLogins()] });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'start-one' },
    body: { folder: '/work/lead', name: 'lead', runtime: MAIN, ...options.start },
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: FerretId }>().id;
  await h.settle();
  atPrompt(h, id);
  runner.starts = 0;
  return { h, runner, harness, source, id, handle: '%1', launches: harness.launched.length };
}

const move = async (h: TestHost, id: string, body: Record<string, unknown>) =>
  await h.request('POST', `/v1/ferrets/${id}/move`, {
    headers: { 'x-fy-request-id': `move-${Math.random()}` },
    body: { agent: TWO, ...body },
  });

/** Every document a refused move must leave exactly as it was. */
const documents = (h: TestHost, id: string) => [
  h.state('ferrets').raw(FerretFiles, id),
  h.state('ferrets').raw(FerretConfigFile, id),
  h.state('ferrets').raw(FerretStateFile, id),
];
const configOf = (h: TestHost, id: string) =>
  JSON.parse(h.state('ferrets').raw(FerretConfigFile, id) ?? '{}') as Record<string, unknown>;
const recordOf = (h: TestHost, id: string) =>
  JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}') as Record<string, unknown>;

describe('moving a ferret onto another login of its harness', () => {
  test('a clean pane moves: the old pane is replaced by one on the other runtime and login, resuming the SAME conversation', async () => {
    const { h, runner, harness, id, handle, launches } = await boot();
    const conversation = recordOf(h, id).harnessConversation;
    expect(conversation).toBe(`conv-${id}`);

    const answer = await move(h, id, {});

    expect(answer.status).toBe(200);
    expect(await runner.alive(handle as never)).toBe(false);
    expect(runner.starts).toBe(1);
    expect(harness.launched).toHaveLength(launches + 1);
    const spec = harness.launched.at(-1);
    expect(spec?.runtime).toBe(TWO);
    expect(spec?.login).toBe('login-two');
    // The ferret's conversation went with it: resumed by the id it was bound to, never a fresh one.
    expect(spec?.harnessConversation).toBe(conversation as string);
    expect(recordOf(h, id)).toMatchObject({ runtime: TWO, login: 'login-two', harnessConversation: conversation });
    expect(configOf(h, id)).toMatchObject({ agent: TWO, harness: 'claude', runtimeGeneration: 2 });
    expect(configOf(h, id).moves).toMatchObject([{ from: MAIN, to: TWO }]);
    await h.stop();
  });

  test('the model it is on goes with it when the target serves it, and the window it runs in is the target’s', async () => {
    const { h, harness, id } = await boot({ start: { model: SONNET } });

    const answer = await move(h, id, {});

    expect(answer.status).toBe(200);
    expect(harness.launched.at(-1)?.model).toBe(SONNET);
    expect(configOf(h, id)).toMatchObject({ model: SONNET, launchModelSource: 'requested' });
    await h.stop();
  });

  test('a ferret on the source runtime’s DEFAULT lands on the target’s own default (the default does not follow it)', async () => {
    const { h, harness, id } = await boot();

    const answer = await move(h, id, { agent: 'claude-big' });

    expect(answer.status).toBe(200);
    expect(harness.launched.at(-1)?.model).toBe(OPUS);
    expect(configOf(h, id)).toMatchObject({ model: OPUS, launchModelSource: 'account-default' });
    await h.stop();
  });

  test('a model the request names is the one the target runs, and the person picked it', async () => {
    const { h, harness, id } = await boot();

    const answer = await move(h, id, { model: OPUS, allowContextDowngrade: true });

    expect(answer.status).toBe(200);
    expect(harness.launched.at(-1)?.model).toBe(OPUS);
    expect(configOf(h, id)).toMatchObject({ model: OPUS, launchModelSource: 'requested' });
    await h.stop();
  });

  test('the effort carries over when the target model takes it, and is dropped (the login’s own) when it does not', async () => {
    const kept = await boot({ start: { model: SONNET, effort: 'high' } });
    expect((await move(kept.h, kept.id, {})).status).toBe(200);
    expect(kept.harness.launched.at(-1)?.effort).toBe('high');
    await kept.h.stop();

    const dropped = await boot({ start: { model: SONNET, effort: 'xhigh' } });
    expect((await move(dropped.h, dropped.id, {})).status).toBe(200);
    expect(dropped.harness.launched.at(-1)?.effort).toBeUndefined();
    await dropped.h.stop();
  });

  test('a ferret can move onward and back: the conversation is still the one it started with', async () => {
    const { h, harness, id } = await boot();
    const conversation = recordOf(h, id).harnessConversation;

    expect((await move(h, id, {})).status).toBe(200);
    // The relaunched agent is mid-turn until it settles; back at its prompt, it moves again.
    atPrompt(h, id);
    expect((await move(h, id, { agent: MAIN, allowContextDowngrade: true })).status).toBe(200);

    expect(harness.launched.at(-1)?.runtime).toBe(MAIN);
    expect(harness.launched.at(-1)?.harnessConversation).toBe(conversation as string);
    expect(configOf(h, id).moves).toMatchObject([
      { from: MAIN, to: TWO },
      { from: TWO, to: MAIN },
    ]);
    await h.stop();
  });
});

describe('every refusal leaves both documents byte-identical and the pane untouched', () => {
  const refused = async (
    shape: Parameters<typeof boot>[0],
    body: Record<string, unknown>,
    expected: { readonly status: number; readonly code: string; readonly says?: string },
  ) => {
    const { h, runner, harness, id, handle, launches } = await boot(shape);
    const before = documents(h, id);
    const answer = await move(h, id, body);
    expect(answer.status).toBe(expected.status);
    expect(answer.json<{ code: string }>().code).toBe(expected.code);
    if (expected.says !== undefined) expect(answer.json<{ error: string }>().error).toContain(expected.says);
    expect(documents(h, id)).toEqual(before);
    expect(await runner.alive(handle as never)).toBe(true);
    expect(runner.starts).toBe(0);
    expect(harness.launched).toHaveLength(launches);
    await h.stop();
  };

  test('a runtime of ANOTHER harness is not built yet', async () => {
    await refused(undefined, { agent: CODEX }, { status: 503, code: 'agent_unavailable', says: 'another harness' });
  });

  test('a runtime Runtimes cannot resolve is refused in the sentence Runtimes gave', async () => {
    await refused(
      undefined,
      { agent: 'nowhere' },
      { status: 503, code: 'agent_unavailable', says: 'there is no runtime named nowhere' },
    );
  });

  test('a runtime that cannot say what it serves is refused (no catalogue, nothing to plan on)', async () => {
    await refused(
      { source: runtimeSource({ catalog: false }) },
      {},
      { status: 503, code: 'agent_unavailable', says: 'what models' },
    );
  });

  test('a model the target does not serve is refused (unservable_model)', async () => {
    await refused(undefined, { model: 'gpt-none' }, { status: 409, code: 'unservable_model', says: 'gpt-none' });
  });

  test('a smaller window is refused unless it is accepted (context_downgrade), with both windows as data', async () => {
    const { h, runner, harness, id, handle } = await boot({ start: { model: OPUS } });
    const before = documents(h, id);

    const answer = await move(h, id, {});

    expect(answer.status).toBe(409);
    expect(answer.json<{ code: string }>().code).toBe('context_downgrade_refused');
    expect(answer.json<{ downgrade?: unknown }>().downgrade).toEqual({
      model: OPUS,
      targetWindow: 200_000,
      currentWindow: 1_000_000,
    });
    expect(documents(h, id)).toEqual(before);
    expect(await runner.alive(handle as never)).toBe(true);
    expect(runner.starts).toBe(0);

    // The same request, once accepted, is the move.
    expect((await move(h, id, { allowContextDowngrade: true })).status).toBe(200);
    expect(harness.launched.at(-1)?.model).toBe(OPUS);
    await h.stop();
  });

  test('converting the conversation onto another harness is not built yet', async () => {
    await refused(
      undefined,
      { conversation: 'convert' },
      { status: 503, code: 'agent_unavailable', says: 'not built yet' },
    );
  });

  test('going back to an earlier conversation is not built yet and never lists the OWNER’s own history', async () => {
    const { h, runner, harness, id, handle } = await boot();
    let listed = 0;
    harness.conversations.list = async () => {
      listed += 1;
      return [{ id: 'owner-newest', updatedAt: '2099-01-01T00:00:00.000Z' }] as never;
    };
    const before = documents(h, id);

    const answer = await move(h, id, { conversation: 'previous' });

    expect(answer.status).toBe(503);
    expect(answer.json<{ error: string }>().error).toContain('not built yet');
    expect(documents(h, id)).toEqual(before);
    expect(await runner.alive(handle as never)).toBe(true);
    expect(listed).toBe(0);
    await h.stop();
  });

  test('a conversation the harness PROVES is not in the ferret’s home is refused, never a silent fresh one (unresumable)', async () => {
    const runner = new FakeRunner();
    const { h, harness, id, handle } = await boot({ runner });
    harness.hasConversation = async () => false;
    const before = documents(h, id);

    const answer = await move(h, id, {});

    expect(answer.status).toBe(409);
    expect(answer.json<{ code: string }>().code).toBe('conversation_unresumable');
    expect(documents(h, id)).toEqual(before);
    expect(await runner.alive(handle as never)).toBe(true);
    expect(runner.starts).toBe(0);

    // Start fresh is the person's explicit choice, and it goes through.
    expect((await move(h, id, { conversation: 'fresh' })).status).toBe(200);
    expect(harness.launched.at(-1)?.harnessConversation).toBeUndefined();
    await h.stop();
  });

  test('a ferret with no recorded conversation cannot resume one (unresumable)', async () => {
    // A harness that never names its conversation (Codex before its first rollout): the record holds none.
    const harness = new FakeHarness();
    const started = harness.start.bind(harness);
    harness.start = async (...args) => {
      const result = await started(...args);
      return result.ok ? ok({ running: result.value.running }) : result;
    };
    const { h, id } = await boot({ harness });
    expect(recordOf(h, id).harnessConversation).toBeUndefined();
    const before = documents(h, id);

    const answer = await move(h, id, {});

    expect(answer.status).toBe(409);
    expect(answer.json<{ code: string }>().code).toBe('conversation_unresumable');
    expect(documents(h, id)).toEqual(before);
    await h.stop();
  });

  test('a pane the runner cannot identify is a blind spot: refused (move_refused), and Move anyway goes through', async () => {
    const runner = new FakeRunner();
    runner.identity = undefined;
    const { h, harness, id, launches } = await boot({ runner });
    const before = documents(h, id);

    const refusedAnswer = await move(h, id, {});

    expect(refusedAnswer.status).toBe(409);
    expect(refusedAnswer.json<{ code: string }>().code).toBe('move_refused');
    // The gate's refusal is journalled; the documents are not touched.
    expect(documents(h, id)).toEqual(before);
    expect(runner.starts).toBe(0);
    expect(harness.launched).toHaveLength(launches);

    expect((await move(h, id, { forceInflight: true })).status).toBe(200);
    expect(runner.starts).toBe(1);
    await h.stop();
  });

  test('a runtime that stops serving between the plan and the launch refuses before the pane is released: nothing was written, to either document', async () => {
    const source = runtimeSource();
    // The plan's own resolve passes; the launch's (the SAME resolution a start uses) finds the runtime off.
    let asked = 0;
    const original = source.resolve.bind(source);
    source.resolve = async runtime => {
      asked += 1;
      return runtime === TWO && asked > 1
        ? { ok: false, sentence: `runtime ${TWO} was switched off` }
        : await original(runtime);
    };
    const { h, runner, harness, id, handle, launches } = await boot({
      source,
      start: { model: SONNET, effort: 'high', fast: true },
    });
    asked = 0;
    const before = documents(h, id);
    const record = recordOf(h, id);

    const answer = await move(h, id, {});

    expect(answer.status).toBe(409);
    expect(answer.json<{ error: string }>().error).toContain('switched off');
    // The pane was never released and the record was never retargeted, and config.json is restamped only once the launch's own
    // refusals have passed (`committed`), so it is untouched byte for byte: the effort and fast mode a move drops are still there.
    expect(await runner.alive(handle as never)).toBe(true);
    expect(runner.starts).toBe(0);
    expect(harness.launched).toHaveLength(launches);
    expect(recordOf(h, id)).toEqual(record);
    expect(documents(h, id).slice(0, 2)).toEqual(before.slice(0, 2));
    await h.stop();
  });
});

describe('a failure after the pane was released leaves both documents on the target', () => {
  test('a launch that does not come up: the record and config name the target, and the failure says so', async () => {
    const { h, runner, id } = await boot();
    runner.resume = async () => err('unavailable' as never);

    const answer = await move(h, id, {});

    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(recordOf(h, id)).toMatchObject({ runtime: TWO, login: 'login-two' });
    expect(configOf(h, id)).toMatchObject({ agent: TWO });
    await h.stop();
  });
});

describe('the conversion preview', () => {
  test('answers refused, in a sentence: conversion is not built yet', async () => {
    const { h, id } = await boot();

    const answer = await h.request('POST', `/v1/ferrets/${id}/conversion-preview`, { body: { agent: CODEX } });

    expect(answer.status).toBe(200);
    expect(answer.json<{ kind: string; reason: string }>()).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('not built yet'),
    });
    await h.stop();
  });
});
