import { expect, test } from 'bun:test';
import { Runners, Logins, RuntimeStart } from '../../../../ferrets/contract/index.ts';
import { FakeRunner, FakeRuntimeStart, FakeLoginKind } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

test('the real mounted start refuses an Anthropic subscription before env/credential/spawn and frees the next start', async () => {
  const runner = new FakeRunner();
  let environments = 0;
  let credentials = 0;
  let spawns = 0;
  const login = new FakeLoginKind();
  const terminals = implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Runner fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
  const runtimes = implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtime fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: 'runtimes' }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': new FakeRuntimeStart() } }) },
  );
  const logins = implementDaemon(
    definePlugin({
      id: 'logins',
      title: 'Login fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Logins, key: 'api-key' }] },
    }),
    {
      build: () => ({
        hooks: {
          'logins:api-key': {
            ...login,
            key: 'api-key' as const,
            harnesses: ['opencode'],
            holds: () => true,
            signIn: () => login.signIn(),
            status: () => login.status(),
            env: async () => {
              environments++;
              return {};
            },
            credential: async () => {
              credentials++;
              return { kind: 'none' as const };
            },
          },
        },
      }),
    },
  );
  const loginView = fakeLogins([
    sampleLogin('subscription', { store: 'ferretry' }),
    sampleLogin('key', { store: 'environment' }),
  ]);
  const host = await testHost({
    everyDirectory: true,
    plugins: [real('ferrets'), real('opencode'), terminals, runtimes, logins],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks: new FakeAsks(),
    },
    uses: { logins: loginView },
    config: { 'harness-opencode.yaml': { binary: '/fake/opencode' } },
    spawn: () => {
      spawns++;
      return { exitCode: 0, signal: null, stdout: 'opencode v2.4.2\n', stderr: '' };
    },
  });
  const start = (login: string, id: string) =>
    host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': id },
      body: {
        harness: 'opencode',
        folder: '/work/project',
        login,
        model: 'deepseek/deepseek-flash',
        mode: 'interactive',
      },
    });
  try {
    const refused = await start('subscription', 'request-one');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('Anthropic Claude subscriptions');
    expect([environments, credentials, spawns, runner.starts]).toEqual([0, 0, 0, 0]);
    const accepted = await start('key', 'request-two');
    expect(accepted.status).toBe(201);
    expect(runner.starts).toBe(1);
    expect([environments, credentials]).toEqual([1, 1]);
    const repeated = await start('key', 'request-two');
    expect(repeated.status).toBe(200);
    expect(runner.starts).toBe(1);
  } finally {
    await host.stop();
  }
});
