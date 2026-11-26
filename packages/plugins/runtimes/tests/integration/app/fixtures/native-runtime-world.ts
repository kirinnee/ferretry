import { HarnessKeySchema, type HarnessRuntimeDescriptor } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { KernelPorts } from '@ferretry/kernel/contract';
import {
  fakeLogins,
  fakeLoginChanges,
  fakeLoginEnvImport,
  sampleLogin,
} from '@ferretry/plugin-logins/contract/testing';
import { runtimesDaemon } from '../../../../daemon/index.ts';
import { RUNTIME_ITEMS, PROFILE_ITEMS } from '../../../../contract/index.ts';
import capture from './native-models-capture.json';

/** Real routes and real model metadata, with synthetic login references and installation facts only. No inference. */
export async function nativeRuntimeWorld(prepared: boolean) {
  const key = HarnessKeySchema.parse('opencode');
  const logins = fakeLogins([
    sampleLogin('deepseek-key', { harnesses: [key], store: 'environment', label: 'DeepSeek API key' }),
  ]);
  logins.setTemplates([
    {
      id: 'deepseek-key',
      kind: 'templates',
      harness: key,
      preset: 'deepseek',
      env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' },
    },
  ]);
  class Registered extends FakeFerrets {
    override harnesses() {
      return ['claude-code', 'codex', key];
    }
    override harnessFacts(id: string) {
      return id === key
        ? {
            displayName: 'OpenCode',
            instructionFile: 'AGENTS.md',
            skillsDir: 'skills',
            mcp: { format: 'json' as const, file: 'opencode.json' },
            transcriptFormat: 'opencode-export',
            catalogHalf: 'opencode',
          }
        : super.harnessFacts(id);
    }
    harnessRuntime(id: string): HarnessRuntimeDescriptor | undefined {
      return id === key
        ? {
            binary: 'opencode',
            homeEnv: {},
            detect: async () => ({ found: true, binary: '/fixture/opencode', version: '2.4.2' }),
            models: async () => capture.models,
          }
        : undefined;
    }
  }
  let kernel: KernelPorts | undefined;
  const daemon = runtimesDaemon();
  const host = await testHost({
    gate: Object.assign(new StandInAdmission(() => ownerStanding()), { judgeConfigWrite: () => 'apply' as const }),
    plugins: [
      {
        ...daemon,
        build: ctx => {
          kernel = ctx.kernel;
          return daemon.build!(ctx as never);
        },
      },
    ],
    fakes: {
      ferrets: new Registered(),
      logins,
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    config: {
      profiles: {
        'claude-only': { contents: ['settings/claude-only'] },
        'codex-only': { contents: ['settings/codex-only'] },
      },
    },
    spawn: () => ({ exitCode: 0, signal: null, stdout: 'Linux\n', stderr: '' }),
  });
  const call = async (
    route: string,
    init?: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown },
  ) => {
    if (route === 'GET /v1/logins') return await logins.list();
    if (route === 'GET /v1/ferrets') return [];
    if (route === 'GET /v1/usage')
      throw Object.assign(new Error('Usage is off in this fixture'), { code: 'plugin_paused', status: 503 });
    const [method, template] = route.split(' ');
    if (template === undefined) throw new Error('a fixture route needs a method and path');
    const path = template.replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(init?.params?.[name] ?? name));
    const answer = await host.request(method as 'GET' | 'POST', path, { body: init?.body });
    if (answer.status >= 400) {
      const body = answer.json<{ error?: { message?: string; code?: string } }>();
      throw Object.assign(new Error(body.error?.message ?? JSON.stringify(body)), {
        code: body.error?.code,
        status: answer.status,
        body,
      });
    }
    return answer.json();
  };
  if (prepared) {
    const staged = (await call('POST /v1/runtimes/proposals', {
      body: {
        change: {
          kind: 'runtime.put',
          name: 'opencode-plain',
          credential: 'deepseek-key',
          profile: 'opencode-plain',
          harness: key,
          create: true,
          createPlainProfile: true,
        },
      },
    })) as { id: string };
    await call('POST /v1/runtimes/proposals/:id/apply', { params: { id: staged.id }, body: {} });
  }
  return {
    host,
    call,
    close: () => host.stop(),
    state: () => ({
      runtimes: [...(kernel?.config.collection(RUNTIME_ITEMS as never).keys() ?? [])],
      profiles: [...(kernel?.config.collection(PROFILE_ITEMS as never).keys() ?? [])],
    }),
  };
}
