import { expect, test } from 'bun:test';
import type { HarnessRuntimeDescriptor } from '../../../../ferrets/contract/index.ts';
import { FakeFerrets } from '../../../../ferrets/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import {
  fakeLogins,
  fakeLoginChanges,
  fakeLoginEnvImport,
  sampleLogin,
} from '../../../../../plugins/logins/contract/testing/index.ts';
import { RUNTIME_ITEMS, PROFILE_ITEMS } from '../../../../../plugins/runtimes/contract/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost, fixedClock } from '../../../testing/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import type { HostFs } from '../../../host/state/host-fs.ts';
import type { Log } from '../../../contract/index.ts';
import type { ConfigDeclaration } from '../../../host/config/claims.ts';

test('native runtime and plain profile use the real config transaction: a second-file IO failure leaves neither', async () => {
  const implementation = daemonImplementations.find(item => item.manifest.id === 'runtimes');
  if (implementation?.build === undefined) throw new Error('the generated registry has no Runtimes daemon');
  const home = '/synthetic/native-runtime-profile';
  const runtimePath = `${home}/config/runtimes/opencode-plain.yaml`;
  const profilePath = `${home}/config/profiles/opencode-plain.yaml`;
  const disk = createMemoryHostFs();
  disk.seed(`${home}/config/profiles/claude-only.yaml`, 'contents: [settings/claude-only]\n');
  disk.seed(`${home}/config/profiles/codex-only.yaml`, 'contents: [settings/codex-only]\n');
  let armed = false;
  let failedAfterRuntime = false;
  const fs: HostFs = {
    ...disk,
    writeAtomic: async (path, data, mode) => {
      if (armed && path === profilePath) {
        armed = false;
        failedAfterRuntime = disk.snapshot().has(runtimePath);
        throw new Error('synthetic second-file disk failure');
      }
      await disk.writeAtomic(path, data, mode);
    },
  };
  const log: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  const clock = fixedClock('2026-11-26T08:00:00Z');
  const files = createConfigFiles({
    home,
    fs,
    clock,
    log,
    binary: 'fy',
    etagKey: new Uint8Array(32).fill(7),
    defs: (implementation.manifest.data?.config ?? []).map((def: ConfigDeclaration['def']) => ({
      plugin: 'runtimes',
      def,
    })),
    judge: () => true,
  });
  await files.reload();
  const config = files.port('runtimes');
  class RegisteredFerrets extends FakeFerrets {
    override harnesses() {
      return ['claude-code', 'codex', 'opencode'];
    }
    override harnessFacts(key: string) {
      return key === 'opencode'
        ? {
            displayName: 'OpenCode',
            instructionFile: 'AGENTS.md',
            skillsDir: 'skills',
            mcp: { format: 'json' as const, file: 'opencode.json' },
            transcriptFormat: 'opencode-export',
            catalogHalf: 'opencode',
          }
        : super.harnessFacts(key);
    }
    harnessRuntime(key: string): HarnessRuntimeDescriptor | undefined {
      return key === 'opencode'
        ? {
            binary: 'opencode',
            homeEnv: {},
            detect: async () => ({ found: true, binary: '/fixture/opencode', version: '2.4.2' }),
            models: async () => ({
              choices: [{ id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash' }],
              default: 'deepseek/deepseek-flash',
            }),
          }
        : undefined;
    }
  }
  const host = await testHost({
    plugins: [
      { ...implementation, build: ctx => implementation.build!({ ...ctx, kernel: { ...ctx.kernel, config } }) },
    ],
    clock,
    fakes: {
      ferrets: new RegisteredFerrets(),
      vault: new FakeVault(),
      logins: fakeLogins([sampleLogin('key', { store: 'environment', harnesses: ['opencode'] })]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
    },
    spawn: () => ({ exitCode: 0, signal: null, stdout: 'Linux\n', stderr: '' }),
  });
  try {
    const staged = await host.request('POST', '/v1/runtimes/proposals', {
      body: {
        change: {
          kind: 'runtime.put',
          name: 'opencode-plain',
          credential: 'key',
          profile: 'opencode-plain',
          harness: 'opencode',
          create: true,
          createPlainProfile: true,
        },
      },
    });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(
      staged.json<{ preview: { documents: { path: string }[] } }>().preview.documents.map(item => item.path),
    ).toEqual(['runtimes/opencode-plain.yaml', 'profiles/opencode-plain.yaml']);
    const id = staged.json<{ id: string }>().id;
    armed = true;
    const failed = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
    expect(failed.status).toBe(500);
    expect(failedAfterRuntime).toBe(true);
    expect(disk.snapshot().get(runtimePath)).toBeUndefined();
    expect(disk.snapshot().get(profilePath)).toBeUndefined();
    expect(config.collection(RUNTIME_ITEMS as never).size).toBe(0);
    expect(config.collection(PROFILE_ITEMS as never).has('opencode-plain')).toBe(false);
    expect((await host.request('GET', `/v1/runtimes/proposals/${id}`)).json()).toMatchObject({ state: 'pending' });
    const retried = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(config.collection(RUNTIME_ITEMS as never).has('opencode-plain')).toBe(true);
    expect(config.collection(PROFILE_ITEMS as never).get('opencode-plain')).toEqual({ contents: [] });
  } finally {
    await host.stop();
  }
});
