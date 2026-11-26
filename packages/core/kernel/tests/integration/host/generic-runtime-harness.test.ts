import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Harnesses,
  HarnessKeySchema,
  Logins,
  Runners,
  type HarnessRuntimeDescriptor,
  type HarnessRuntimeModels,
} from '../../../../ferrets/contract/index.ts';
import { FakeFerrets, FakeHarness, FakeRunner, FakeLoginKind } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import {
  fakeLogins,
  fakeLoginChanges,
  fakeLoginEnvImport,
  sampleLogin,
} from '../../../../../plugins/logins/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../host/roots.ts';
import { testHost } from '../../../testing/index.ts';
import { LoginsPort } from '../../../../../plugins/logins/contract/index.ts';
import { RuntimesPort, RuntimeIdSchema } from '../../../../../plugins/runtimes/contract/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

test('real Logins checks metadata for the exact generic destination before status or store reads', async () => {
  let reads = 0;
  let spawns = 0;
  const original = real('logins');
  const logins = {
    ...original,
    build: (ctx: Parameters<NonNullable<typeof original.build>>[0]) => {
      const roots = ctx.kernel.roots;
      return original.build!({
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
  };
  class RegisteredFerrets extends FakeFerrets {
    override harnesses() {
      return ['claude-code', 'codex', 'opencode', 'fourth', 'claude'];
    }
    override harnessFacts(key: string) {
      return { ...super.harnessFacts('claude-code')!, displayName: key };
    }
    harnessRuntime(): HarnessRuntimeDescriptor {
      return {
        binary: 'fixture',
        homeEnv: {},
        detect: async () => ({ found: true, binary: '/fixture', version: '1' }),
        models: async () => ({ choices: [{ id: 'provider/model', label: 'Model' }], default: 'provider/model' }),
      };
    }
  }
  const host = await testHost({
    everyDirectory: true,
    plugins: [logins, real('runtimes')],
    fakes: { ferrets: new RegisteredFerrets(), vault: new FakeVault(), gate: new FakeGate() },
    config: {
      logins: {
        subscription: { harness: 'claude-code', store: 'ferretry' },
        key: { harness: 'claude-code', store: 'environment', preset: 'anthropic-api-key', env: {} },
      },
      runtimes: {
        fourth: { harness: 'fourth', login: 'subscription', profile: 'plain' },
        compatible: { harness: 'opencode', login: 'key', profile: 'plain' },
      },
      profiles: { plain: { contents: [] } },
    },
    spawn: () => {
      spawns++;
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
  });
  try {
    // Finish the expiry watch's initial login read before measuring this resolution's own I/O.
    await host.provided(LoginsPort).list();
    await host.settle();
    await host.clock.advance(60_000);
    reads = 0;
    spawns = 0;
    const api = host.provided(RuntimesPort);
    expect(await api.resolve(RuntimeIdSchema.parse('fourth'))).toMatchObject({ ok: false });
    expect([reads, spawns]).toEqual([0, 0]);
    expect(await api.resolve(RuntimeIdSchema.parse('compatible'), 'fourth')).toMatchObject({ ok: false });
    expect([reads, spawns]).toEqual([0, 0]);
    const metadata = host.provided(LoginsPort);
    for (const key of ['fourth', 'claude']) {
      expect(await metadata.launchRefusal('key', key)).toBeDefined();
      expect(await metadata.launchRefusal('missing', key)).toBeDefined();
    }
    expect([reads, spawns]).toEqual([0, 0]);
    expect(await metadata.launchRefusal('key', 'opencode')).toBeUndefined();
    expect(await metadata.launchRefusal('subscription', 'claude-code')).toBeUndefined();
    expect(await metadata.launchRefusal('subscription', 'codex')).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test('a fake fourth registered harness can be added and launched through real Runtimes and Ferrets without a per-harness Runtimes row', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'generic-runtime-harness-'));
  try {
    const home = join(scratch, 'fy');
    await mkdir(join(home, 'fleet'), { recursive: true });
    const roots = rootsPortFor(
      nodeFs(randomUUID),
      { home, plugin: 'runtimes', worktrees: join(scratch, 'worktrees') },
      ['fleet', 'harness-home'],
      () => undefined,
      { harnessFiles: [], setMode: true },
    );
    const runtimeHalf = real('runtimes');
    const runtimes = {
      ...runtimeHalf,
      build: (ctx: Parameters<NonNullable<typeof runtimeHalf.build>>[0]) =>
        runtimeHalf.build!({ ...ctx, kernel: { ...ctx.kernel, roots } }),
    };
    const runner = new FakeRunner();
    let models: HarnessRuntimeModels = {
      choices: ['provider/model', 'provider/pinned', 'provider/explicit'].map(id => ({ id, label: id })),
      default: 'provider/model',
    };
    class FourthHarness extends FakeHarness {
      readonly runtime: HarnessRuntimeDescriptor = {
        binary: 'fourth',
        homeEnv: { FOURTH_HOME: '' },
        detect: () => this.discover(),
        models: async () => models,
      };
    }
    const harness = new FourthHarness('fourth', join(scratch, 'harness-homes'), {
      displayName: 'Fourth',
      instructionFile: 'RULES.md',
      skillsDir: 'skills',
      mcp: { format: 'json', file: 'fourth.json' },
      transcriptFormat: 'fourth',
      catalogHalf: 'fourth',
    });
    // Harnesses is a restricted producer hook: use an approved producer identity while registering a genuinely new key.
    const plugin = implementDaemon(
      definePlugin({
        id: 'opencode',
        title: 'Fourth harness fixture',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: ['harness'],
        hooks: { takes: [{ hook: Harnesses, key: 'fourth' }] },
      }),
      { build: () => ({ hooks: { 'harnesses:fourth': harness } }) },
    );
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
    const fakeKind = new FakeLoginKind();
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
              key: 'api-key' as const,
              harnesses: ['fourth'],
              fields: fakeKind.fields,
              holds: () => true,
              env: async () => ({}),
              signIn: () => fakeKind.signIn(),
              status: () => fakeKind.status(),
            },
          },
        }),
      },
    );
    const loginFacts = fakeLogins([sampleLogin('key', { store: 'environment', harnesses: ['fourth'] })]);
    loginFacts.setTemplates([
      {
        id: 'key',
        kind: 'templates',
        harness: HarnessKeySchema.parse('fourth'),
        env: { FOURTH_API_KEY: '${secret:FOURTH_API_KEY}' },
      },
    ]);
    const host = await testHost({
      everyDirectory: true,
      plugins: [real('ferrets'), runtimes, plugin, terminals, logins],
      gate: Object.assign(new StandInAdmission(() => ownerStanding()), { judgeConfigWrite: () => 'apply' as const }),
      fakes: {
        gate: new FakeGate(),
        vault: new FakeVault(),
        asks: new FakeAsks(),
        logins: loginFacts,
        loginChanges: fakeLoginChanges(),
        loginEnvImport: fakeLoginEnvImport(),
      },
      config: {
        profiles: { plain: { contents: [] }, pinned: { contents: ['modelSets/pinned'] } },
        'model-sets': { pinned: { models: ['provider/pinned'], default: 'provider/pinned' } },
        runtimes: { pinned: { harness: 'fourth', login: 'key', profile: 'pinned' } },
      },
      ownerHome: join(scratch, 'person'),
      spawn: () => ({ exitCode: 0, signal: null, stdout: 'Linux\n', stderr: '' }),
    });
    try {
      const machine = await host.request('GET', '/v1/runtimes/machine');
      expect(machine.status, JSON.stringify(machine.body)).toBe(200);
      expect(machine.json<{ tools: unknown[] }>().tools).toContainEqual({
        harness: 'fourth',
        label: 'Fourth',
        installed: true,
        command: '/usr/bin/fake-harness',
      });
      const staged = await host.request('POST', '/v1/runtimes/proposals', {
        body: {
          change: {
            kind: 'runtime.put',
            name: 'custom',
            credential: 'key',
            profile: 'plain',
            harness: 'fourth',
            create: true,
          },
        },
      });
      expect(staged.status, JSON.stringify(staged.body)).toBe(200);
      expect(
        (await host.request('POST', `/v1/runtimes/proposals/${staged.json<{ id: string }>().id}/apply`, { body: {} }))
          .status,
      ).toBe(200);
      const start = (model: string | undefined, id: string, runtime = 'custom') =>
        host.request('POST', '/v1/ferrets', {
          headers: { 'x-fy-request-id': id },
          body: {
            runtime,
            harness: 'fourth',
            folder: join(scratch, 'project'),
            ...(model === undefined ? {} : { model }),
            mode: 'interactive',
          },
        });
      const refused = await start('unlisted/model', 'refused');
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(runner.starts).toBe(0);
      const accepted = await start(undefined, 'accepted');
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      expect(runner.starts).toBe(1);
      expect(harness.launched[0]).toMatchObject({
        harness: 'fourth',
        runtime: 'custom',
        login: 'key',
        model: 'provider/model',
      });
      expect((await start(undefined, 'accepted')).status).toBe(200);
      expect(runner.starts).toBe(1);
      expect((await start(undefined, 'pinned', 'pinned')).status).toBe(201);
      expect(harness.launched[1]?.model).toBe('provider/pinned');
      expect((await start('provider/explicit', 'explicit', 'pinned')).status).toBe(201);
      expect(harness.launched[2]?.model).toBe('provider/explicit');
      models = { choices: models.choices, default: 'unlisted/default' };
      expect((await start(undefined, 'no-default')).status).toBe(409);
      expect(runner.starts).toBe(3);
    } finally {
      await host.stop();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
