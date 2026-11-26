import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import {
  StartDecide,
  type StartDecideInput,
  startFingerprintText,
  RuntimeStart,
  RUNTIME_START_KEY,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host, fakeLogins, fakeRuntimeStartAnswer } from './route-fixture.ts';
import { ClientSessionApi } from '../../../../cli/lib/client.ts';
import { emptyNewFerretDraft, startFerret } from '../../../../app/features/new-ferret/new-ferret-draft.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { FerretsClient } from '../../../../app/lib/client.ts';

const world = async (verified = false) => {
  const catalog = { verified };
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  const plugin = implementDaemon(
    definePlugin({
      id: 'codex',
      title: 'Catalog fixture',
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
            input.fast === true && !catalog.verified
              ? {
                  allow: false,
                  code: 'fast_unverified',
                  reason: "Started without Fast: Codex's model list is still loading; try again in a few seconds",
                }
              : { allow: true },
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
  return {
    h: await host([], { harness, runner, plugins: [plugin, runtimes, fakeLogins()] }),
    harness,
    runner,
    catalog,
  };
};
const body = { name: 'wren', folder: '/work/a', model: 'gpt-x', fast: true };
const headers = { 'x-fy-request-id': 'fast-fallback-exact' };
test('E-266 R2 fallback hands the harness explicit Fast false so priority defaults cannot win', async () => {
  const { h, harness } = await world();
  expect((await h.request('POST', '/v1/ferrets', { body, headers })).status).toBe(201);
  expect(harness.launched.at(-1)?.options?.fast).toBe(false);
});

test('E-266 R2 lost first response keeps the same notice on identical POST replay and GET recovery, persisted with the ferret', async () => {
  const { h, runner } = await world();
  const first = (await h.request('POST', '/v1/ferrets', { body, headers })).json<{ id: string; notice: string }>();
  expect(first.notice).toContain('Started without Fast:');
  const replay = await h.request('POST', '/v1/ferrets', { body, headers });
  expect(replay.status).toBe(200);
  expect(replay.json()).toEqual(first);
  const digest = createHash('sha256')
    .update(startFingerprintText(JSON.stringify(body)))
    .digest('hex');
  const recovered = await h.request('GET', '/v1/ferrets/by-request/fast-fallback-exact', {
    query: { payload: digest },
  });
  expect(recovered.status).toBe(200);
  expect(recovered.json()).toMatchObject(first);
  expect(
    [...h.state('ferrets').files.entries()].some(
      ([path, value]) =>
        path.includes(first.id) && path.endsWith('details.json') && String(value).includes(first.notice),
    ),
  ).toBe(true);
  expect(runner.starts).toBe(1);
  const rebooted = await h.restart();
  expect((await rebooted.request('POST', '/v1/ferrets', { body, headers })).json()).toEqual(first);
  expect(
    (
      await rebooted.request('GET', '/v1/ferrets/by-request/fast-fallback-exact', { query: { payload: digest } })
    ).json(),
  ).toMatchObject(first);
});

test('E-266 R2 GET recovery preserves the notice when both POST answers were lost', async () => {
  const { h } = await world();
  const first = (await h.request('POST', '/v1/ferrets', { body, headers })).json<{ id: string; notice: string }>();
  const digest = createHash('sha256')
    .update(startFingerprintText(JSON.stringify(body)))
    .digest('hex');
  expect(
    (await h.request('GET', '/v1/ferrets/by-request/fast-fallback-exact', { query: { payload: digest } })).json(),
  ).toMatchObject(first);
});

for (const surface of ['CLI', 'app'] as const)
  for (const lost of [1, 2])
    test(`E-266 R2 ${surface} receives the downgrade after ${lost === 1 ? 'POST replay' : 'GET recovery'}`, async () => {
      const { h, runner } = await world();
      let posts = 0;
      const client: PluginClient = {
        call: async <Answer>(route: string, init?: Parameters<PluginClient['call']>[1]): Promise<Answer> => {
          const [method, template] = route.split(' ');
          if (template === undefined) throw new Error(`invalid route ${route}`);
          const path = template.replace(/:([a-zA-Z]+)/gu, (_, key: string) => init?.params?.[key] ?? '');
          const answer = await h.request(method as 'POST' | 'GET', path, {
            body: init?.body,
            query: init?.query,
            headers: { ...init?.headers },
          });
          if (answer.status >= 400) throw Object.assign(new Error(answer.body), { status: answer.status });
          if (route === 'POST /v1/ferrets' && ++posts <= lost) throw new TypeError('fetch failed');
          return answer.json<Answer>();
        },
        subscribe: () => () => undefined,
      };
      const answer =
        surface === 'CLI'
          ? await new ClientSessionApi(client).start(body)
          : await startFerret(client as FerretsClient, {
              ...emptyNewFerretDraft,
              runtime: 'fake',
              folder: '/work/a',
              prompt: 'Do the fixture task',
              model: 'gpt-x',
              fast: true,
            });
      expect(answer.notice).toContain('Started without Fast:');
      expect(runner.starts).toBe(1);
    });

test('E-266 R2 resume after catalog verification disappears returns and records the notice and explicitly launches standard', async () => {
  const { h, harness, catalog } = await world(true);
  const first = (await h.request('POST', '/v1/ferrets', { body, headers })).json<{ id: string }>();
  expect(harness.launched.at(-1)?.options?.fast).toBe(true);
  await h.request('POST', `/v1/ferrets/${first.id}/stop`, { body: {} });
  catalog.verified = false;
  const resumed = await h.request('POST', `/v1/ferrets/${first.id}/resume`, { body: {} });
  expect(resumed.status).toBe(200);
  expect(resumed.json<{ notice?: string }>().notice).toContain('Started without Fast:');
  expect(harness.launched.at(-1)?.options?.fast).toBe(false);
  expect((await h.request('GET', `/v1/ferrets/${first.id}`)).json()).toMatchObject({
    fast: false,
    notice: resumed.json<{ notice: string }>().notice,
  });
});

test('E-266 R2 restart uses the same recorded notice when catalog verification disappears', async () => {
  const { h, harness, catalog } = await world(true);
  const { id } = (await h.request('POST', '/v1/ferrets', { body, headers })).json<{ id: string }>();
  catalog.verified = false;
  const answer = await h.request('POST', '/v1/restarts', { body: { scope: 'ids', ids: [id], when: 'now' } });
  expect(answer.status).toBe(200);
  expect(answer.json<{ restarted: { id: string; notice?: string }[] }>().restarted[0]).toMatchObject({
    id,
    notice: expect.stringContaining('Started without Fast:'),
  });
  expect(harness.launched.at(-1)?.options?.fast).toBe(false);
});
