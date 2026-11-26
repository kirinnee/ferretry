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
} from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, FakeLoginKind } from '../../../../ferrets/contract/testing/index.ts';
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

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

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
    class FourthHarness extends FakeHarness {
      readonly runtime: HarnessRuntimeDescriptor = {
        binary: 'fourth',
        homeEnv: { FOURTH_HOME: '' },
        detect: () => this.discover(),
        models: async () => ({ choices: [{ id: 'provider/model', label: 'Fourth model' }], default: 'provider/model' }),
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
      config: { profiles: { plain: { contents: [] } } },
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
      const start = (model: string, id: string) =>
        host.request('POST', '/v1/ferrets', {
          headers: { 'x-fy-request-id': id },
          body: { runtime: 'custom', harness: 'fourth', folder: join(scratch, 'project'), model, mode: 'interactive' },
        });
      const refused = await start('unlisted/model', 'refused');
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(runner.starts).toBe(0);
      const accepted = await start('provider/model', 'accepted');
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      expect(runner.starts).toBe(1);
      expect(harness.launched[0]).toMatchObject({
        harness: 'fourth',
        runtime: 'custom',
        login: 'key',
        model: 'provider/model',
      });
      expect((await start('provider/model', 'accepted')).status).toBe(200);
      expect(runner.starts).toBe(1);
    } finally {
      await host.stop();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
