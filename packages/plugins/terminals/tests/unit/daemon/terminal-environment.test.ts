import { describe, expect, it } from 'bun:test';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { judgeLoosening } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { TerminalsConfigSchema, terminalsLoosens, type TerminalsConfig } from '../../../contract/index.ts';
import { TmuxTerminalRuntime } from '../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { buildTerminals } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { unarmedHostFacts } from '../../support/daemon/host-facts.ts';
import { ALL_ON, fakeFerrets, fakeVault, FERRET, ScriptedTmux } from '../../support/daemon/half.ts';

const PREVIEW_ENV = {
  __ETC_PROFILE_NIX_SOURCED: '1',
  FY_HOME: '/home/o/.ferretry-v5',
  FY_PORT: '7458',
  FY_URL: 'http://127.0.0.1:7458',
};

const entries = (argv: readonly string[]): string[] =>
  argv.flatMap((word, at) => (argv[at - 1] === '-e' ? [word] : []));

describe('the terminal environment: the runtime', () => {
  const create = {
    ownerId: 'session-a',
    id: '0123456789ab',
    title: 'Terminal 1',
    cwd: '/tmp/w',
    size: { cols: 100, rows: 30 },
  };

  it('passes each entry as a new-session -e NAME=value argument, for an owner and an agent opener', async () => {
    for (const openedBy of [{ by: 'local' }, { by: 'agent', sessionId: 'session-a' }] as const) {
      const tmux = new ScriptedTmux();
      const runtime = new TmuxTerminalRuntime(
        tmux,
        () => 1_000,
        { shell: async () => '/bin/sh' },
        undefined,
        () => PREVIEW_ENV,
      );

      await runtime.create({ ...create, openedBy });

      const argv = tmux.calls[0] as readonly string[];
      expect(argv[0]).toBe('new-session');
      expect(entries(argv)).toEqual(Object.entries(PREVIEW_ENV).map(([name, value]) => `${name}=${value}`));
      // the shell, last before the chained commands, is never a joined string
      expect(argv.slice(argv.indexOf('30') + 1 + 2 * Object.keys(PREVIEW_ENV).length, argv.indexOf(';'))).toEqual([
        '/bin/sh',
        '-l',
      ]);
    }
  });

  it('asks for the environment at every open, never caching it', async () => {
    let current: Record<string, string> = { A: '1' };
    const tmux = new ScriptedTmux();
    const runtime = new TmuxTerminalRuntime(
      tmux,
      () => 1_000,
      { shell: async () => '/bin/sh' },
      undefined,
      () => current,
    );

    await runtime.create(create);
    current = { B: '2' };
    await runtime.create(create);

    expect(entries(tmux.calls[0] as readonly string[])).toEqual(['A=1']);
    expect(entries(tmux.calls[1] as readonly string[])).toEqual(['B=2']);
  });

  it('adds no -e at all when nothing is configured', async () => {
    const tmux = new ScriptedTmux();
    await new TmuxTerminalRuntime(tmux, () => 1_000, { shell: async () => '/bin/sh' }).create(create);
    expect((tmux.calls[0] as readonly string[]).includes('-e')).toBe(false);
  });
});

describe('the terminal environment: the daemon reads the file live', () => {
  async function subject() {
    const tmux = new ScriptedTmux();
    let caller: 'ferret' | 'owner' = 'owner';
    const plugin = implementDaemon(manifest, {
      build: ctx => buildTerminals(ctx, { tmux, socketPath: '/fixture/state/terminals/tmux.sock' }),
    });
    const host = await testHost({
      hostFacts: unarmedHostFacts,
      plugins: [plugin],
      fakes: { ferrets: fakeFerrets(), vault: fakeVault([]) },
      uses: { agentControl: ALL_ON },
      gate: new StandInAdmission(() => (caller === 'ferret' ? ferretStanding(FERRET) : ownerStanding())),
      spawn: () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    });
    return { host, tmux, as: (who: 'ferret' | 'owner') => (caller = who) };
  }
  const lastOpen = (tmux: ScriptedTmux) => entries(tmux.calls.findLast(call => call[0] === 'new-session') ?? []);

  it('gives the owner terminal and the ferret terminal the configured environment, and follows an edit', async () => {
    const { host, tmux, as } = await subject();
    host.setConfig('terminals.yaml', { environment: PREVIEW_ENV });

    as('owner');
    expect((await host.request('POST', `/v1/ferrets/${FERRET}/terminals`, { body: {} })).status).toBe(201);
    expect(lastOpen(tmux)).toContain('FY_HOME=/home/o/.ferretry-v5');

    as('ferret');
    expect((await host.tool('terminal_open', { name: 'dev' })).isError).not.toBe(true);
    expect(lastOpen(tmux)).toContain('FY_HOME=/home/o/.ferretry-v5');

    host.setConfig('terminals.yaml', { environment: { ONLY: 'x' } });
    as('owner');
    await host.request('POST', `/v1/ferrets/${FERRET}/terminals`, { body: {} });
    expect(lastOpen(tmux)).toEqual(['ONLY=x']);
    await host.stop();
  });

  it('opens with no extra environment when the file is invalid', async () => {
    const { host, tmux } = await subject();
    host.setConfig('terminals.yaml', { environment: { PATH: '/evil' } });

    const opened = await host.request('POST', `/v1/ferrets/${FERRET}/terminals`, { body: {} });

    expect(opened.status).toBe(201);
    expect(lastOpen(tmux)).toEqual([]);
    await host.stop();
  });
});

describe('the terminal environment: the file', () => {
  const issues = (environment: Record<string, string>): string[] => {
    const parsed = TerminalsConfigSchema.safeParse({ environment });
    return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('accepts the preview environment', () => {
    expect(issues(PREVIEW_ENV)).toEqual([]);
  });

  it.each([
    'PATH',
    'HOME',
    'SHELL',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'FY_SESSION_TOKEN',
    'FY_SESSION_ID',
    'FY_SESSION_BOARD_CAPABILITY',
  ])('refuses %s, located at the variable', name => {
    const found = issues({ [name]: 'x' });
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(`environment.${name}: ${name} is refused`);
  });

  it.each(['lower', '1ABC', 'A-B', 'A B'])('refuses the name %p', name => {
    expect(issues({ [name]: 'x' })[0]).toContain('is not a usable variable name');
  });

  it('refuses a secret reference value with a sentence about the secret store', () => {
    const found = issues({ FOO: `$\{secret:x}` });
    expect(found).toEqual([
      'environment.FOO: FOO names a secret: a secret reaches a command only through the secret store, never through a terminal environment',
    ]);
  });

  it('refuses a NUL and a value over 4096 bytes, and accepts exactly 4096', () => {
    expect(issues({ A: 'a\0b' })).toEqual(['environment.A: A holds a NUL character']);
    expect(issues({ A: 'x'.repeat(4097) })).toEqual(['environment.A: A is longer than 4096 bytes']);
    expect(issues({ A: 'x'.repeat(4096) })).toEqual([]);
    expect(issues({ A: 'é'.repeat(2049) })).toHaveLength(1);
  });

  it('reports every bad variable as its own issue', () => {
    expect(issues({ PATH: 'x', lower: 'y', OK: 'z' })).toHaveLength(2);
  });
});

describe('the terminal environment: who may change it', () => {
  const file = (environment?: Record<string, string>): TerminalsConfig =>
    TerminalsConfigSchema.parse(environment === undefined ? {} : { environment });
  const judge = (before: TerminalsConfig | undefined, after: TerminalsConfig | undefined) =>
    judgeLoosening({ loosens: terminalsLoosens }, before, after);

  it('holds for the owner any added, changed or removed variable, and the whole file being deleted', () => {
    expect(judge(undefined, file({ A: '1' }))).toEqual(['every terminal will open with A set']);
    expect(judge(file({ A: '1' }), file({ A: '2' }))).toEqual(['every terminal will open with a different A']);
    expect(judge(file({ A: '1' }), file({}))).toEqual(['terminals will stop opening with A set']);
    expect(judge(file({ A: '1' }), undefined)).toEqual(['terminals will stop opening with A set']);
    expect(judge(file({ A: '1' }), file({ A: '1', B: '2' }))).toEqual(['every terminal will open with B set']);
  });

  it('lets an edit that leaves the environment alone through', () => {
    expect(judge(undefined, file())).toEqual([]);
    expect(judge(file({ A: '1' }), { ...file({ A: '1' }), perFerret: 1 })).toEqual([]);
  });

  it('is the judgement the declared file carries', () => {
    const [def] = manifest.data.config;
    expect(def?.loosens).toBe(terminalsLoosens);
  });
});
