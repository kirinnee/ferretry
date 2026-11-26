import { expect, test } from 'bun:test';
import { LaunchParts, Runners, type RunSpec } from '../../../../ferrets/contract/index.ts';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { VaultPort } from '../../../../vault/contract/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

for (const through of ['login', 'runtime', 'inferred-runtime'] as const) {
  test(`real Logins + Runtimes refuse a subscription through ${through} before status/store reads and reuse the callsign`, async () => {
    let reads = 0;
    let spawns = 0;
    let profileEnvironment: Record<string, string> = {};
    const specs: RunSpec[] = [];
    const runner = new (class extends FakeRunner {
      override async start(spec: RunSpec) {
        specs.push(spec);
        return await super.start(spec);
      }
    })();
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
    const profile = implementDaemon(
      definePlugin({
        id: 'profile-fixture',
        title: 'Profile environment',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { takes: [{ hook: LaunchParts }] },
      }),
      {
        build: () => ({
          hooks: {
            'launch.parts': () => [
              {
                id: 'profile-fixture',
                item: {
                  parts: async () => [{ kind: 'env', env: profileEnvironment }],
                },
              },
            ],
          },
        }),
      },
    );
    const original = real('logins');
    const logins = implementDaemon(original.manifest, {
      build: ctx => {
        if (original.build === undefined) throw new Error('no Logins build');
        const roots = ctx.kernel.roots;
        return original.build({
          ...ctx,
          kernel: {
            ...ctx.kernel,
            roots: {
              ...roots,
              root: (name, scope) => {
                const root = roots.root(name, scope);
                if (name !== 'credentials') return root;
                return new Proxy(root, {
                  get(target, property) {
                    const value = Reflect.get(target, property);
                    return typeof value !== 'function'
                      ? value
                      : (...args: unknown[]) => {
                          reads++;
                          return value.apply(target, args);
                        };
                  },
                });
              },
            },
          },
        });
      },
    });
    const host = await testHost({
      everyDirectory: true,
      plugins: [real('vault'), real('ferrets'), logins, real('runtimes'), real('opencode'), terminals, profile],
      gate: new StandInAdmission(() => ownerStanding()),
      fakes: { gate: new FakeGate(), asks: new FakeAsks() },
      config: {
        'harness-opencode.yaml': { binary: '/fake/opencode' },
        logins: {
          subscription: { harness: 'claude-code', store: 'ferretry' },
          key: {
            harness: 'claude-code',
            store: 'environment',
            preset: 'anthropic-api-key',
            env: { ANTHROPIC_API_KEY: '${secret:KEY}' },
          },
          endpoint: {
            harness: 'claude-code',
            store: 'environment',
            preset: 'deepseek',
            env: { DEEPSEEK_API_KEY: '${secret:OAUTH}' },
          },
        },
        runtimes: {
          subscription: {
            ...(through === 'inferred-runtime' ? {} : { harness: 'opencode' }),
            login: 'subscription',
            profile: 'plain',
          },
          key: { harness: 'opencode', login: 'key', profile: 'plain' },
          endpoint: { harness: 'opencode', login: 'endpoint', profile: 'plain' },
        },
        profiles: { plain: { contents: [] } },
      },
      spawn: () => {
        spawns++;
        return { exitCode: 0, signal: null, stdout: 'opencode v2.4.2\n', stderr: '' };
      },
    });
    const start = (
      account: string,
      id: string,
      selector: 'login' | 'runtime' = through === 'login' ? 'login' : 'runtime',
    ) =>
      host.request('POST', '/v1/ferrets', {
        headers: { 'x-fy-request-id': id },
        body: {
          harness: 'opencode',
          name: id.startsWith('request-') ? 'reusable' : id,
          folder: '/work/project',
          [selector]: account,
          model: 'deepseek/deepseek-flash',
          mode: 'interactive',
        },
      });
    try {
      await host.provided(VaultPort).put('KEY', 'sk-ant-api03-SYNTHETIC-NOT-A-CREDENTIAL');
      await host.provided(VaultPort).put('OAUTH', 'sk-ant-oat01-SYNTHETIC-NOT-A-CREDENTIAL');
      reads = 0;
      spawns = 0;
      const refused = await start('subscription', 'request-one');
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('Anthropic Claude subscriptions');
      expect([reads, spawns, specs.length]).toEqual([0, 0, 0]);
      const accepted = await start('key', 'request-two', 'login');
      expect(accepted).toMatchObject({ status: 201 });
      expect(specs.length).toBe(1);
      const endpoint = await start('endpoint', 'endpoint-refused', 'login');
      expect(endpoint).toMatchObject({ status: 409 });
      expect(JSON.stringify(endpoint.body)).toContain('subscription credentials');
      expect(JSON.stringify(endpoint.body)).not.toContain('sk-ant-');
      profileEnvironment = { PROFILE_SETTING: '${secret:OAUTH}' };
      const profileRefused = await start('key', 'profile-refused', 'login');
      expect(profileRefused).toMatchObject({ status: 409 });
      expect(JSON.stringify(profileRefused.body)).toContain('subscription credentials');
      expect(JSON.stringify(profileRefused.body)).not.toContain('sk-ant-');
      expect(specs.length).toBe(1);
      expect((await start('key', 'request-two', 'login')).status).toBe(200);
      expect(specs.length).toBe(1);
    } finally {
      await host.stop();
    }
  });
}
