/**
 * `fy daemon setup` (V-0241): v4's questions in v4's order, driven over the routes Runtimes serves to the app, with a
 * fake daemon behind the plugin client and a scripted terminal. Nothing here reads a real home.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import type { SetupScan } from '@ferretry/plugin-runtimes/contract';
import cli from '../../../cli/index.ts';
import { renderHarnessScan, runDaemonSetup, type SetupDeps } from '../../../cli/lib/setup.ts';

const ROUTE = {
  machine: 'GET /v1/runtimes/machine',
  scan: 'GET /v1/runtimes/setup/scan',
  install: 'POST /v1/runtimes/machine/tools/install',
  propose: 'POST /v1/runtimes/proposals',
  apply: 'POST /v1/runtimes/proposals/:proposalId/apply',
} as const;

const CHANGE_ID = 'fy_fprop_AAAAAAAAAAAAAAAAAAAAAA';

const machine = (overrides: Record<string, unknown> = {}) => ({
  name: 'studio',
  format: 'none',
  setUp: false,
  agentPermissions: 'auto',
  defaultRuntime: null,
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: null,
  tools: [],
  runtimeCount: 0,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
  ...overrides,
});

const harness = (key: 'claude-code' | 'codex', installed: boolean, state = 'signed-in') => ({
  harness: key,
  installed,
  account: { state, ...(state === 'signed-in' ? { email: 'you@example.com' } : {}) },
  mcpServers: [],
  skills: [],
  secretKeys: [],
  missingCommands: [],
  problems: [],
});

const scan = (overrides: Partial<SetupScan> = {}): SetupScan =>
  ({
    machine: 'studio',
    format: 'none',
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true },
      { harness: 'codex', label: 'Codex', installed: true },
    ],
    harnesses: [harness('claude-code', true), harness('codex', true, 'not-signed-in')],
    runtimes: [
      { harness: 'claude-code', name: 'claude-default', profile: 'default' },
      { harness: 'codex', name: 'codex-default', profile: 'default' },
    ],
    updates: [],
    duplicates: [],
    notes: [],
    importing: { available: true },
    ...overrides,
  }) as SetupScan;

const view = (change: unknown) => ({
  id: CHANGE_ID,
  revision: 'r1',
  change,
  summary: 'Import claude-default',
  consequences: ['claude-default shares your terminal login'],
  expiresAt: '2026-11-16T00:10:00.000Z',
  state: 'pending',
  preview: {
    kind: 'apply',
    operations: [],
    documents: [],
    runtimes: [{ name: 'claude-default', harness: 'claude-code', agent: true, launch: { available: true } }],
  },
});

const committed = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: { accountCount: 1, operationCount: 3, manifestPath: '/fy/m.json', prunedWrappers: [], sharedHistory: [] },
  },
};

interface Call {
  readonly route: string;
  readonly body?: unknown;
  readonly params?: Record<string, string>;
}

/** The daemon, in memory: each route's answer (a list is played in order, the last repeating), and every call made. */
function daemon(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const client: PluginClient = {
    async call<Answer>(route: string, init?: { params?: Record<string, string>; body?: unknown }): Promise<Answer> {
      calls.push({
        route,
        ...(init?.body === undefined ? {} : { body: init.body }),
        ...(init?.params === undefined ? {} : { params: init.params }),
      });
      const given = answers[route];
      const answer = route === ROUTE.propose ? view((init as { body: { change: unknown } }).body.change) : given;
      if (answer instanceof Error) throw answer;
      if (Array.isArray(answer) && route === ROUTE.scan) {
        const seen = calls.filter(call => call.route === ROUTE.scan).length;
        return answer[Math.min(seen, answer.length) - 1] as Answer;
      }
      return answer as Answer;
    },
    subscribe: () => () => {},
  };
  return { client, calls, routes: () => calls.map(call => call.route) };
}

/** A person at a terminal: each question gets the next scripted answer; every question asked is kept. */
function person(...answers: string[]) {
  const asked: string[] = [];
  const queue = [...answers];
  return {
    asked,
    prompt: {
      async ask(question: string) {
        asked.push(question);
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected question: ${question}`);
        return next;
      },
    },
  };
}

function setup(client: PluginClient, prompt: SetupDeps['prompt']) {
  const report: string[] = [];
  const warn: string[] = [];
  const deps: SetupDeps = {
    client,
    prompt,
    bin: 'fy',
    out: { report: text => report.push(text), warn: text => warn.push(text) },
  };
  return { deps, report, warn };
}

const flags = { dryRun: false, json: false };

describe('daemon setup', () => {
  test('V-0241 refuses with nobody to ask, names `daemon import`, and calls nothing', async () => {
    const fake = daemon({});
    const { deps, warn } = setup(fake.client, undefined);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn).toEqual([
      '`fy daemon setup` asks a few questions, so it needs a terminal. In a script, run `fy daemon import claude` or `fy daemon import codex` instead.',
    ]);
    expect(fake.calls).toEqual([]);
  });

  test('V-0241 asks one question at a time, then stages ONE setup.import with the chosen names and applies exactly it', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: committed });
    const you = person('', 'n', 'work');
    const { deps, report } = setup(fake.client, you.prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(you.asked).toEqual([
      'We found Claude Code on studio. Use your login and setup? [Y/n]',
      'We found Codex on studio. Use your login and setup? [Y/n]',
      'Name for the Claude Code runtime [claude-default]:',
    ]);
    const proposed = fake.calls.find(call => call.route === ROUTE.propose);
    expect(proposed?.body).toEqual({
      change: { kind: 'setup.import', include: ['claude-code'], names: { 'claude-code': 'work' } },
    });
    expect(fake.calls.find(call => call.route === ROUTE.apply)?.params).toEqual({ proposalId: CHANGE_ID });
    expect(report.join('\n')).toContain('Import claude-default');
    expect(report.join('\n')).toContain('Done.');
    expect(report.join('\n')).toContain('See what was set up with `fy runtime ls` and `fy login ls`.');
  });

  test('V-0241 says a login that is not signed in still needs `login signin`', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: committed });
    const { deps, report } = setup(fake.client, person('n', 'y', '').prompt);
    await runDaemonSetup(deps, flags);
    expect(report).toContain('Your Codex login is not signed in. You can still import it, and sign in afterwards.');
    expect(report.join('\n')).toContain(
      'Codex is not signed in yet: find its login with `fy login ls`, then run `fy login signin <login>` before you launch.',
    );
  });

  test('V-0241 offers to install what is missing first, says the command, then scans again', async () => {
    const missing = scan({
      tools: [
        { harness: 'claude-code', label: 'Claude Code', installed: true },
        {
          harness: 'codex',
          label: 'Codex',
          installed: false,
          install: { kind: 'runnable', command: 'npm i -g @openai/codex' },
        },
      ],
      harnesses: [harness('claude-code', true), harness('codex', false)],
    } as Partial<SetupScan>);
    const fake = daemon({
      [ROUTE.machine]: machine(),
      [ROUTE.scan]: [missing, scan()],
      [ROUTE.install]: { outcomes: [{ harness: 'codex', outcome: 'installed', command: 'npm i -g @openai/codex' }] },
      [ROUTE.apply]: committed,
    });
    const you = person('y', 'n', 'n');
    const { deps, report } = setup(fake.client, you.prompt);
    await runDaemonSetup(deps, flags);
    expect(you.asked[0]).toBe('Codex is not installed. Install now? [Y/n]');
    expect(report).toContain('Codex will be installed with: npm i -g @openai/codex');
    expect(report).toContain('Codex is installed.');
    expect(fake.calls.find(call => call.route === ROUTE.install)?.body).toEqual({ harnesses: ['codex'] });
    expect(fake.routes().filter(route => route === ROUTE.scan)).toHaveLength(2);
  });

  test('V-0241 stages and applies nothing when every tool is declined', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan() });
    const { deps, report } = setup(fake.client, person('n', 'n').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(report.at(-1)).toBe(
      'Nothing was set up, so studio has no runtimes yet. Run `fy daemon setup` again when you are ready, or finish in the app.',
    );
    expect(fake.routes()).toEqual([ROUTE.machine, ROUTE.scan]);
  });

  test('V-0241 offers an update to a changed component, defaulting to no, and imports again on a machine that is set up', async () => {
    const again = scan({
      format: 'present',
      updates: [{ reference: 'instructions/main', sources: ['CLAUDE.md'] }],
    } as Partial<SetupScan>);
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: again, [ROUTE.apply]: committed });
    const you = person('n', 'n', '');
    const { deps } = setup(fake.client, you.prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(you.asked.at(-1)).toBe('instructions/main changed in CLAUDE.md since the last import. Update it? [y/N]');
    expect(fake.routes()).toEqual([ROUTE.machine, ROUTE.scan]);
  });

  test('V-0241 --dry-run stages the change, shows it, and applies nothing', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan() });
    const { deps, report } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, { dryRun: true, json: false })).toBe(0);
    expect(fake.routes()).toContain(ROUTE.propose);
    expect(fake.routes()).not.toContain(ROUTE.apply);
    expect(report.at(-1)).toBe('Dry run: nothing was changed.');
  });

  test('V-0241 --json prints the change and its outcome as JSON and nothing else on stdout', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: committed });
    const { deps, report } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, { dryRun: false, json: true })).toBe(0);
    const printed = report.filter(line => line.startsWith('{'));
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0] as string)).toMatchObject({
      change: { id: CHANGE_ID },
      outcome: { outcome: 'applied' },
    });
  });

  test('V-0241 exits non-zero when the apply did not land', async () => {
    const rolledBack = {
      outcome: 'applied',
      apply: { outcome: 'rolled-back', failedOperation: 'Write config', reason: 'disk full' },
    };
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: rolledBack });
    const { deps, warn } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn).toEqual(['Write config failed: disk full']);
  });

  test('V-0241 refuses in words, before it scans, when this caller may not change the machine', async () => {
    const fake = daemon({
      [ROUTE.machine]: machine({ authority: { mayApply: false, applyRefusal: 'step-up-required' } }),
    });
    const { deps, warn } = setup(fake.client, person().prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn[0]).toContain('needs a passkey confirmation');
    expect(fake.routes()).toEqual([ROUTE.machine]);
  });

  test('V-0241 refuses with the daemon’s reason when the machine takes no import now', async () => {
    const fake = daemon({
      [ROUTE.machine]: machine(),
      [ROUTE.scan]: scan({
        importing: { available: false, reason: 'Account changes are switched off.' },
      } as Partial<SetupScan>),
    });
    const { deps, warn } = setup(fake.client, person().prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn).toEqual(['Account changes are switched off.']);
  });

  test('V-0241 says an executed change in its own words and exits 0', async () => {
    const executed = { outcome: 'executed', executor: 'setup', summary: 'Imported claude-default.' };
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: executed });
    const { deps, report, warn } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(report).toContain('Imported claude-default.');
    expect(warn).toEqual([]);
  });

  test('V-0241 exits non-zero and says so when the change did not apply as a setup import', async () => {
    const other = { outcome: 'login-changed', result: 'applied' };
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: other });
    const { deps, warn } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn).toEqual(['The change did not apply as a setup import.']);
  });

  test('V-0241 exits non-zero when it saved but the shared history could not be set up', async () => {
    const partial = {
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude-code',
        reason: 'permission denied',
        committed: {
          accountCount: 1,
          operationCount: 3,
          manifestPath: '/fy/m.json',
          manifest: { version: 1, generatedAt: '2026-11-16T00:00:00.000Z', accounts: [] },
          prunedWrappers: [],
          sharedHistory: [],
        },
      },
    };
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan(), [ROUTE.apply]: partial });
    const { deps, warn } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(1);
    expect(warn).toEqual(['Saved, but the shared claude-code history could not be set up: permission denied']);
  });

  test('V-0241 says when a tool cannot be installed from here, and names the command when an install fails', async () => {
    const missing = scan({
      tools: [
        { harness: 'claude-code', label: 'Claude Code', installed: true },
        {
          harness: 'codex',
          label: 'Codex',
          installed: false,
          install: { kind: 'no-package-manager', reason: 'No npm was found.', manualCommand: 'npm i -g @openai/codex' },
        },
      ],
      harnesses: [harness('claude-code', true), harness('codex', false)],
    } as Partial<SetupScan>);
    const fake = daemon({
      [ROUTE.machine]: machine(),
      [ROUTE.scan]: [missing, scan()],
      [ROUTE.install]: {
        outcomes: [
          {
            harness: 'codex',
            outcome: 'failed',
            cause: 'no-package-manager',
            reason: 'No npm was found.',
            manualCommand: 'npm i -g @openai/codex',
          },
        ],
      },
    });
    const { deps, report, warn } = setup(fake.client, person('y', 'n', 'n').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(report).toContain(
      'Codex cannot be installed from here: No npm was found.\n  Run it yourself: npm i -g @openai/codex',
    );
    expect(warn).toEqual(['Codex was not installed: No npm was found.\n  Run it yourself: npm i -g @openai/codex']);
  });

  test('V-0241 reports each tool’s notes, and a duplicate only for a tool that is being imported', async () => {
    const noted = scan({
      notes: [{ harness: 'claude-code', text: 'CLAUDE.md and AGENTS.md say the same thing.' }],
      duplicates: [
        { harness: 'claude-code', existing: 'claude-main', suggested: 'claude-default' },
        { harness: 'codex', existing: 'codex-main', suggested: 'codex-default' },
      ],
    } as Partial<SetupScan>);
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: noted, [ROUTE.apply]: committed });
    const { deps, report } = setup(fake.client, person('y', 'n', '').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(report).toContain('Claude Code: CLAUDE.md and AGENTS.md say the same thing.');
    expect(report).toContain(
      'claude-main already uses that Claude Code login and profile, so no new runtime is added.',
    );
    expect(report.join('\n')).not.toContain('codex-main');
  });

  test('V-0241 changes nothing, and says so, when a machine that is set up declines everything', async () => {
    const again = scan({ format: 'present' } as Partial<SetupScan>);
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: again });
    const { deps, report } = setup(fake.client, person('n', 'n').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(report.at(-1)).toBe('Nothing was imported. Your runtimes are unchanged.');
    expect(fake.routes()).toEqual([ROUTE.machine, ROUTE.scan]);
  });

  test('V-0241 stages an accepted update even when no tool is imported again', async () => {
    const again = scan({
      format: 'present',
      updates: [{ reference: 'instructions/main', sources: ['CLAUDE.md', 'AGENTS.md'] }],
    } as Partial<SetupScan>);
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: again, [ROUTE.apply]: committed });
    const { deps } = setup(fake.client, person('n', 'n', 'y').prompt);
    expect(await runDaemonSetup(deps, flags)).toBe(0);
    expect(fake.calls.find(call => call.route === ROUTE.propose)?.body).toEqual({
      change: { kind: 'setup.import', include: [], acceptedUpdates: ['instructions/main'] },
    });
  });

  test('V-0241 rethrows what is not an Error instead of saying it as a sentence', async () => {
    const client: PluginClient = {
      call: async () => {
        throw 'not an error';
      },
      subscribe: () => () => {},
    };
    const { deps, warn } = setup(client, person().prompt);
    await expect(runDaemonSetup(deps, flags)).rejects.toBe('not an error');
    expect(warn).toEqual([]);
  });
});

describe('renderHarnessScan', () => {
  test('says what was found by name only, and where secret-looking settings went', () => {
    const text = renderHarnessScan({
      ...harness('claude-code', true),
      secretKeys: ['env.ANTHROPIC_API_KEY'],
      skills: ['review'],
    } as never);
    expect(text).toBe(
      [
        'Claude Code',
        '  Your login: signed in as you@example.com',
        '  MCP servers: none',
        '  Skills: review',
        '  Moved to the secret store, never copied as text: env.ANTHROPIC_API_KEY',
      ].join('\n'),
    );
  });

  test('names the instructions, the settings, what is missing and what went wrong, and why a login is not usable', () => {
    const text = renderHarnessScan({
      ...harness('codex', true, 'not-shareable'),
      account: { state: 'not-shareable', reason: 'It is kept in the keychain.' },
      instructions: { name: 'main', source: 'AGENTS.md', bytes: 120 },
      settings: { source: 'config.toml', count: 4, hooks: 1 },
      missingCommands: ['rg'],
      problems: ['config.toml line 3 could not be read'],
    } as never);
    expect(text).toBe(
      [
        'Codex',
        '  Your login: not shareable (It is kept in the keychain.)',
        '  Instructions: AGENTS.md',
        '  Settings: config.toml (4 setting(s), 1 hook(s))',
        '  MCP servers: none',
        '  Skills: none',
        '  Command not found on this machine: rg',
        '  Problem: config.toml line 3 could not be read',
      ].join('\n'),
    );
  });
});

describe('the cli half', () => {
  const terminal = (tty: boolean, ask?: (message: string) => Promise<string>) => {
    const err: string[] = [];
    const io: TerminalIo = {
      out: () => {},
      err: text => err.push(text),
      isTty: tty,
      ...(ask === undefined ? {} : { ask }),
    };
    return { io, err };
  };
  const verbs = (io: TerminalIo, client: PluginClient) => {
    const built = cli.build?.({ manifest: cli.manifest, client, io });
    if (built === undefined) throw new Error('the cli half has a build');
    return built.verbs;
  };

  test('declares `daemon setup` next to the three onboard verbs', () => {
    expect(Object.keys(verbs(terminal(false).io, daemon({}).client)).sort()).toEqual([
      'daemon setup',
      'onboard',
      'onboard reset',
      'onboard status',
    ]);
  });

  test('refuses off a terminal even with --yes, and asks nothing', async () => {
    const fake = daemon({});
    const { io, err } = terminal(false);
    const code = await verbs(io, fake.client)['daemon setup']?.({ options: { yes: true } } as never);
    expect(code).toBe(1);
    expect(err.join('')).toContain('needs a terminal');
    expect(fake.calls).toEqual([]);
  });

  test('on a terminal that can ask, runs the questions through it', async () => {
    const fake = daemon({ [ROUTE.machine]: machine(), [ROUTE.scan]: scan() });
    const asked: string[] = [];
    const { io } = terminal(true, async message => {
      asked.push(message);
      return 'n';
    });
    expect(await verbs(io, fake.client)['daemon setup']?.({ options: {} } as never)).toBe(0);
    expect(asked[0]).toBe('We found Claude Code on studio. Use your login and setup? [Y/n]');
  });
});
