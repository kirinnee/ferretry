import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { definePort, type KernelPorts } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost, fixedClock } from '@ferretry/kernel/testing';
import { ModelCatalogSourcesSchema } from '@ferretry/plugin-logins/contract';
import {
  Harnesses,
  StartDecide,
  type Harness,
  type StartDecideInput,
  type RunSpec,
} from '@ferretry/core-ferrets/contract';
import {
  FakeRunner,
  sampleLaunchSpec,
  emptyChildEnvironment,
  harnessConformance,
} from '@ferretry/core-ferrets/contract/testing';
import daemon from '../../daemon/index.ts';
import { OPENCODE_CONFIG, OPENCODE_SESSIONS } from '../../contract/index.ts';

const Probe = definePort<{
  harness(): Harness;
  decide(input: StartDecideInput): Promise<{ allow: boolean; reason?: string }>;
  kernel(): KernelPorts;
}>('harness-probe');
const harnessOwner = implementDaemon(
  definePlugin({
    id: 'ferrets',
    title: 'Harness test owner',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    provides: { probe: Probe },
    hooks: { offers: [{ hook: Harnesses }, { hook: StartDecide }] },
  }),
  {
    build(ctx) {
      return {
        provides: {
          probe: {
            harness() {
              const harness = ctx.hooks.providers(Harnesses).get('opencode');
              if (harness === undefined) throw new Error('OpenCode is not registered');
              return harness;
            },
            decide: input => ctx.hooks.decide(StartDecide, input),
            kernel: () => ctx.kernel,
          },
        },
      };
    },
  },
);

async function fixture(options: { version?: string; subscription?: boolean; exportFailure?: boolean } = {}) {
  const calls: { program: string; args: readonly string[]; env: unknown; sealed?: boolean }[] = [];
  const raw = JSON.parse(await readFile(new URL('../fixtures/spike/export-after.json', import.meta.url), 'utf8'));
  const host = await testHost({
    plugins: [harnessOwner, daemon],
    clock: fixedClock('2026-11-26T08:00:00Z'),
    uses: {
      logins: {
        environmentTemplates: async () => [
          {
            id: 'key',
            kind: 'templates',
            harness: 'opencode',
            preset: 'deepseek',
            env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' },
          },
        ],
        modelSources: async () =>
          ModelCatalogSourcesSchema.parse({
            catalogs: {
              deepseek: {
                id: 'deepseek',
                origin: 'file',
                label: 'DeepSeek',
                docs: 'https://models.dev',
                verified: '2026-11-26',
                opencode: { models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash', tier: 'fast', default: true }] },
              },
            },
            presets: [{ id: 'deepseek', catalog: 'deepseek', variables: {} }],
            discovery: {
              providers: {
                deepseek: {
                  name: 'DeepSeek',
                  env: ['DEEPSEEK_API_KEY'],
                  models: { 'deepseek-flash': { name: 'DeepSeek Flash', tool_call: true } },
                },
              },
            },
          }),
        launchRefusal: async () =>
          options.subscription
            ? 'OpenCode refuses subscription sign-ins, including Anthropic Claude subscriptions; choose an API key or endpoint login'
            : undefined,
      },
    },
    config: { 'harness-opencode.yaml': { binary: '/fake/opencode' } },
    spawn(program, args, spawnOptions) {
      calls.push({ program, args, env: spawnOptions?.env, sealed: spawnOptions?.sealed });
      if (args.includes('--version'))
        return { exitCode: 0, signal: null, stdout: `opencode v${options.version ?? '2.4.2'}\n`, stderr: '' };
      if (args[0] === 'session' && args[1] === 'export') {
        return {
          exitCode: options.exportFailure ? 1 : 0,
          signal: null,
          stdout: JSON.stringify({ ...raw, info: { ...raw.info, id: args[2] } }),
          stderr: '',
        };
      }
      throw new Error('unexpected command');
    },
  });
  const probe = host.provided(Probe);
  const harness = probe.harness();
  const spec = {
    ...sampleLaunchSpec('opencode'),
    home: await harness.homeFor(sampleLaunchSpec().ferret),
    login: 'key',
    model: 'deepseek/deepseek-flash',
  };
  return { host, probe, harness, spec, calls, runner: new FakeRunner() };
}

harnessConformance('registered OpenCode V2', async () => {
  const f = await fixture();
  return { harness: f.harness, runner: f.runner, spec: f.spec, deliveredCount: () => 0, deliversElsewhere: true };
});

describe('OpenCode private launches', () => {
  test('the registered OpenCode descriptor exposes private home names, V2 detection and separate public discovery', async () => {
    const f = await fixture();
    const runtime = f.harness.runtime;
    expect(runtime).toBeDefined();
    if (runtime === undefined) throw new Error('the registered OpenCode harness has no runtime descriptor');
    expect(runtime.binary).toBe('/fake/opencode');
    expect(runtime.homeEnv).toMatchObject({ HOME: 'home', OPENCODE_DB: 'data/opencode.db', TMPDIR: 'tmp' });
    expect(await runtime.detect()).toMatchObject({ found: true, version: '2.4.2' });
    expect(await runtime.models('key')).toEqual({
      choices: [{ id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash' }],
      default: 'deepseek/deepseek-flash',
    });
    expect(await runtime.models('missing')).toEqual({ choices: [] });
    await f.host.stop();
  });
  test('native command arrays are preserved; malformed commands and unqualified models refuse before launch', async () => {
    const f = await fixture();
    await f.harness.prepareHome({
      ...f.spec,
      parts: [{ kind: 'mcp', name: 'native', config: { command: ['bun', 'server.ts'] } }],
    });
    const document = JSON.parse(f.host.rootText('agent-homes', 'f1/opencode.json') ?? 'null');
    expect(document.mcp.servers.native.command).toEqual(['bun', 'server.ts']);
    await expect(
      f.harness.prepareHome({ ...f.spec, parts: [{ kind: 'mcp', name: 'broken', config: { command: 42 } }] }),
    ).rejects.toThrow('unsupported MCP command');
    await expect(f.harness.prepareHome({ ...f.spec, model: 'unqualified' })).rejects.toThrow('provider/model');
    expect(f.runner.starts).toBe(0);
  });

  test('writes native model/variant, instructions, skills and MCP only in the ferret home', async () => {
    const f = await fixture();
    await f.harness.prepareHome({
      ...f.spec,
      effort: 'high',
      parts: [
        { kind: 'instruction', id: 'test', text: 'Finish the task.' },
        { kind: 'mcp', name: 'local', config: { command: 'bun', args: ['server.ts'], env: { TEST: 'yes' } } },
        { kind: 'mcp', name: 'remote', config: { type: 'http', url: 'http://127.0.0.1:7488/mcp' } },
      ],
    });
    const config = JSON.parse(f.host.rootText('agent-homes', 'f1/opencode.json') ?? 'null');
    expect(config).toMatchObject({
      model: 'deepseek/deepseek-flash#high',
      mcp: { servers: { local: { type: 'local', command: ['bun', 'server.ts'] }, remote: { type: 'remote' } } },
    });
    expect(config.instructions).toEqual([`${f.spec.home}/AGENTS.md`]);
    expect(f.host.rootText('agent-homes', 'f1/AGENTS.md')).toContain('Finish the task.');
    await f.harness.prepareHome(f.spec);
    expect(f.host.rootText('agent-homes', 'f1/AGENTS.md')).not.toContain('Finish the task.');
  });

  test('launch stamps the registered key and private paths, resume verifies export before starting', async () => {
    const f = await fixture();
    let run: RunSpec | undefined;
    const start = f.runner.start.bind(f.runner);
    f.runner.start = async spec => {
      run = spec;
      return start(spec);
    };
    const launched = await f.harness.start(f.spec, f.runner, emptyChildEnvironment());
    expect(launched.ok).toBe(true);
    if (!launched.ok || run === undefined) throw new Error('launch did not run');
    expect(run.harness).toBe('opencode');
    expect(run.command).toContain('--standalone');
    expect(run.command).toContain('--auto');
    expect(run.command).toContain(`OPENCODE_DB=${f.spec.home}/data/opencode.db`);
    expect(launched.value.harnessConversation).toMatch(/^ses_/u);
    expect(await f.harness.transcript.read(f.spec.ferret)).toHaveLength(8);
    expect(await f.harness.usage.turns(f.spec.ferret)).toHaveLength(3);
    expect(await f.harness.conversations.list()).toMatchObject([
      { id: launched.value.harnessConversation, title: 'Ferretry isolation spike' },
    ]);
    expect(await f.harness.conversations.list(f.spec.folder)).toEqual([]);
    const resumed = await f.harness.resume(
      f.spec,
      f.runner,
      emptyChildEnvironment(),
      launched.value.harnessConversation ?? 'missing',
    );
    expect(resumed.ok).toBe(true);
    expect(
      f.calls
        .filter(call => call.args[0] === 'session')
        .every(call => call.args.includes('--standalone') && call.sealed),
    ).toBe(true);
  });

  test('V1 is unavailable; missing/private-export failure cannot create a resumed session', async () => {
    const old = await fixture({ version: '1.19.6' });
    expect(await old.harness.discover()).toMatchObject({ found: false });
    expect(await old.harness.start(old.spec, old.runner, emptyChildEnvironment())).toEqual({
      ok: false,
      error: 'unavailable',
    });
    const f = await fixture({ exportFailure: true });
    await expect(f.harness.resume(f.spec, f.runner, emptyChildEnvironment(), 'ses_missing')).rejects.toThrow(
      'not present',
    );
    expect(f.runner.starts).toBe(0);
  });

  test('subscription preflight is a named refusal, and does not invoke a credential or spawn', async () => {
    const f = await fixture({ subscription: true });
    const answer = await f.probe.decide({
      ferret: f.spec.ferret,
      name: 'Fern',
      role: 'lead',
      harness: 'opencode',
      login: 'subscription',
      folder: '/work',
      by: 'owner',
    });
    expect(answer.allow).toBe(false);
    expect(answer.reason).toContain('Anthropic Claude subscriptions');
    expect(f.calls).toEqual([]);
    expect(f.harness.accepts).not.toContain('anthropic');
    await expect(f.harness.prepareHome({ ...f.spec, credential: {} as never })).rejects.toThrow('subscription');
    expect(f.calls).toEqual([]);
  });

  test('permission prompting stays enabled in auto mode; loosening mode/binary is held', async () => {
    expect(OPENCODE_CONFIG.loosens({ permissionMode: 'auto' }, { permissionMode: 'skip' })).toHaveLength(1);
    expect(OPENCODE_CONFIG.loosens({ permissionMode: 'skip' }, { permissionMode: 'auto' })).toHaveLength(0);
    expect(
      OPENCODE_CONFIG.loosens({ permissionMode: 'skip' }, { permissionMode: 'skip', binary: '/other' }),
    ).toHaveLength(1);
    expect(OPENCODE_SESSIONS.path).toBe('sessions/*.json');
    const f = await fixture();
    f.host.setConfig('harness-opencode.yaml', { binary: '/fake/opencode', permissionMode: 'auto' });
    let argv: readonly string[] = [];
    const start = f.runner.start.bind(f.runner);
    f.runner.start = async spec => {
      argv = spec.command;
      return start(spec);
    };
    await f.harness.start(f.spec, f.runner, emptyChildEnvironment());
    expect(argv).not.toContain('--auto');
  });
});
