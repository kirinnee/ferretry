import { describe, expect, it } from 'bun:test';
import type { FleetMachineView, FleetSetupScan } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { MachineFirstRun } from '../../../../../src/features/fleet/setup/first-run.tsx';
import type { FirstRunMode } from '../../../../../src/features/fleet/setup/first-run-model.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import {
  APPLY_PATH,
  type Call,
  credentials,
  credentialView,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  NOTHING_INSTALLED,
  runtimes,
  runtimeView,
  STUDIO,
  scan,
  scriptedClient,
} from './setup-support.ts';

const SCAN_PATH = '/v1/fleet/setup/scan';
const RUNTIMES_PATH = '/v1/fleet/runtimes';
const CHANGES_PATH = '/v1/fleet/proposals';
const INSTALL_PATH = '/v1/fleet/machine/tools/install';

const STAGED_IMPORT = {
  id: 'fy_fprop_abcdefghijklmnopqrstuv',
  revision: 'absent',
  change: { kind: 'setup.import' },
  summary: 'Import this machine’s setup',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'executor', executor: 'setup', description: 'Imports Claude Code and Codex.' },
};

const EXECUTED = { outcome: 'executed', executor: 'setup', summary: 'studio-mac is ready' };

const [CLAUDE_SCAN, CODEX_SCAN] = scan().harnesses as [FleetSetupScan['harnesses'][0], FleetSetupScan['harnesses'][0]];

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
};

const clickOn = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const typeInto = async (element: Element | null, value: string, what: string): Promise<void> => {
  const input = must(element as HTMLInputElement | null, what);
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

interface Harness {
  readonly view: Mounted;
  readonly q: (selector: string) => Element | null;
  readonly text: (selector?: string) => string;
  readonly done: number[];
  readonly left: number[];
  readonly retried: number[];
  readonly rerender: (overrides: Partial<Options>) => Promise<void>;
}

interface Options {
  readonly mode: FirstRunMode;
  readonly machine: FleetMachineView | null;
  readonly online: boolean;
}

const start = async (client: FleetClient, options: Partial<Options> = {}): Promise<Harness> => {
  const done: number[] = [];
  const left: number[] = [];
  const retried: number[] = [];
  const createClient = async () => client;
  const element = (current: Options) => (
    <MachineFirstRun
      mode={current.mode}
      connection={STUDIO}
      machineName="studio-mac"
      machine={current.machine}
      online={current.online}
      checking={false}
      onRetry={() => retried.push(1)}
      createClient={createClient}
      onDone={() => done.push(1)}
      onLeave={() => left.push(1)}
      pollMs={5}
    />
  );
  let current: Options = { mode: 'setup', machine: FRESH_MACHINE, online: true, ...options };
  const view = await mount(element(current));
  await settle();
  const q = (selector: string) => view.container.querySelector(selector);
  return {
    view,
    q,
    text: (selector?: string) => (selector === undefined ? view.container.textContent : q(selector)?.textContent) ?? '',
    done,
    left,
    retried,
    rerender: async overrides => {
      current = { ...current, ...overrides };
      await view.render(element(current));
      await settle();
    },
  };
};

const step = (h: Harness): string | null => h.q('[data-first-run-step]')?.getAttribute('data-first-run-step') ?? null;

const changeBodies = (calls: readonly Call[]) =>
  calls.filter(call => call.path === CHANGES_PATH).map(call => (call.body as { change: unknown }).change);

describe('MachineFirstRun: reading the scan', () => {
  it('says it is looking until the scan answers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = scriptedClient({
      '/v1/fleet/machine': machineAnswer(),
      [SCAN_PATH]: scan(),
      [RUNTIMES_PATH]: runtimes([]),
    });
    const client: FleetClient = {
      request: async (path, schema, init) => {
        if (path === SCAN_PATH) await gate;
        return await inner.request(path, schema, init);
      },
    };
    const h = await start(client);
    try {
      expect(h.text('[data-first-run-reading]')).toBe('Looking at what’s on studio-mac…');
      await interact(() => release());
      await settle();
      expect(step(h)).toBe('tools');
    } finally {
      await h.view.unmount();
    }
  });

  it('a browser that will be asked for a passkey looks at the machine at once, with no password field', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }),
        [SCAN_PATH]: scan(),
        [RUNTIMES_PATH]: runtimes([]),
      },
      calls,
    );
    const h = await start(client);
    try {
      expect(calls.some(call => call.path === SCAN_PATH)).toBe(true);
      expect(h.q('[data-change-password]')).toBeNull();
      expect(step(h)).toBe('tools');
    } finally {
      await h.view.unmount();
    }
  });

  it('a scan that fails says so and Try again reads it again', async () => {
    let up = false;
    const client = scriptedClient({
      '/v1/fleet/machine': machineAnswer(),
      [SCAN_PATH]: () => (up ? scan() : new Error('unreachable')),
      [RUNTIMES_PATH]: runtimes([]),
    });
    const h = await start(client);
    try {
      const note = h.q('[data-setup-note="scan-failed"]');
      expect(note?.textContent).toContain('Couldn’t look at studio-mac');
      expect(step(h)).toBeNull();
      up = true;
      await clickOn(h.q('[data-scan-retry]'), 'try again');
      expect(h.q('[data-setup-note="scan-failed"]')).toBeNull();
      expect(step(h)).toBe('tools');
    } finally {
      await h.view.unmount();
    }
  });
});

describe('MachineFirstRun: Check tools', () => {
  it('everything installed: one row each and Continue', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
    );
    try {
      expect(h.text('[data-first-run-step="tools"]')).toContain(
        'Ferretry runs Claude Code and Codex on studio-mac. First it checks they’re installed.',
      );
      expect(h.text('[data-setup-row="tool-claude"]')).toContain('Installed');
      expect(h.text('[data-setup-row="tool-codex"]')).toContain('Installed');
      expect(h.q('[data-setup-section="install"]')).toBeNull();
      expect(h.q('[data-install-skip]')).toBeNull();
      expect((h.q('[data-step-next]') as HTMLButtonElement).disabled).toBe(false);
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('claude');
    } finally {
      await h.view.unmount();
    }
  });

  it('missing tools: install offered, Continue held, Skip says where to install later', async () => {
    const h = await start(
      scriptedClient({
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: NOTHING_INSTALLED,
        [RUNTIMES_PATH]: runtimes([]),
      }),
    );
    try {
      expect(h.text('[data-setup-row="tool-claude"]')).toContain('Not installed');
      expect(h.text('[data-setup-section="install"]')).toContain('npm install -g @anthropic-ai/claude-code');
      expect((h.q('[data-step-next]') as HTMLButtonElement).disabled).toBe(true);
      await clickOn(h.q('[data-install-skip]'), 'skip');
      expect(h.text('[data-install-skipped]')).toBe(
        'Skipped. You can install Claude Code and Codex later in Settings.',
      );
      expect(h.q('[data-setup-section="install"]')).toBeNull();
      expect(h.q('[data-install-skip]')).toBeNull();
      expect((h.q('[data-step-next]') as HTMLButtonElement).disabled).toBe(false);

      // Neither harness is installed, so both steps are one quiet line (E3) and nothing is imported (E10).
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('claude');
      expect(h.text('[data-setup-note="not-installed"]')).toBe(
        'Claude Code isn’t installed on studio-mac. You can install it later in Settings.',
      );
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('codex');
      expect(h.text('[data-setup-note="not-installed"]')).toBe(
        'Codex isn’t installed on studio-mac. You can install it later in Settings.',
      );
      await clickOn(h.q('[data-step-next]'), 'continue');
      // Nothing set up: said plainly, with the way back.
      expect(h.q('[data-first-run-result="nothing"]')?.textContent).toContain('Nothing is set up on studio-mac yet');
      expect(h.text()).toContain(
        'That’s fine. Ferretry can’t start a session on studio-mac until it has a runtime. Set it up any time from Settings, or add a runtime yourself.',
      );
      await clickOn(h.q('[data-first-run-start-again]'), 'start again');
      expect(step(h)).toBe('tools');
      expect(h.done).toHaveLength(0);
      for (const _ of [1, 2, 3]) await clickOn(h.q('[data-step-next]'), 'continue');
      await clickOn(h.q('[data-first-run-finish]'), 'go to runtimes');
      expect(h.done).toHaveLength(1);
    } finally {
      await h.view.unmount();
    }
  });

  it('installing a tool reads the machine again and lets the flow go on', async () => {
    const calls: Call[] = [];
    let installed = false;
    const afterInstall = scan({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true },
        NOTHING_INSTALLED.tools[1] as FleetSetupScan['tools'][0],
      ],
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, installed: false }],
    });
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: () => (installed ? afterInstall : NOTHING_INSTALLED),
        [RUNTIMES_PATH]: runtimes([]),
        [INSTALL_PATH]: () => {
          installed = true;
          return {
            outcomes: [
              { harness: 'claude', outcome: 'installed', command: 'npm install -g @anthropic-ai/claude-code' },
            ],
          };
        },
      },
      calls,
    );
    const h = await start(client);
    try {
      expect(h.text('[data-change-submit]')).toBe('Install 1 tool');
      await clickOn(h.q('[data-change-submit]'), 'install');
      expect(calls.find(call => call.path === INSTALL_PATH)?.body).toEqual({ harnesses: ['claude'] });
      expect(calls.filter(call => call.path === SCAN_PATH)).toHaveLength(2);
      expect(h.text('[data-setup-row="tool-claude"]')).toContain('Installed');
      expect(h.text('[data-setup-note="installed"]')).toContain('Next, Ferretry looks for your existing setup.');
      expect(h.q('[data-install-skip]')).toBeNull();
      expect((h.q('[data-step-next]') as HTMLButtonElement).disabled).toBe(false);
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('claude');
      expect(h.text('[data-harness-import]')).toBe('Import');
    } finally {
      await h.view.unmount();
    }
  });
});

describe('MachineFirstRun: the harness steps', () => {
  it('asks one question per tool, Skip moves on and Back asks again (E4 sign in later, problems, E9 badge)', async () => {
    const withProblems = scan({
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, problems: ['Couldn’t read config.toml: it is not valid TOML.'] }],
    });
    const h = await start(
      scriptedClient({
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: withProblems,
        [RUNTIMES_PATH]: runtimes([]),
      }),
      { mode: 'import', machine: machineView() },
    );
    try {
      // Import again has no Check tools step.
      expect(step(h)).toBe('claude');
      expect(h.text('[data-stepper-position]')).toBe('Step 1 of 2 · Claude Code');
      expect(h.text('[data-first-run-question]')).toBe('We found Claude Code on studio-mac. Use your login and setup?');
      const claude = h.text('[data-first-run-step="claude"]');
      expect(claude).toContain('you@example.com');
      expect(claude).toContain('2 secret values · go to the secret store, never shown');
      expect(claude).toContain('Ferretry and your own claude share this login: signing out in one signs out both.');
      expect(claude).not.toContain('Component');
      expect(h.q('[data-setup-note="problem"]')).toBeNull();
      expect(h.q('[data-setup-note="sign-in-now"]')).toBeNull();
      expect(h.text('[data-harness-skip]')).toBe('Skip');
      expect(h.text('[data-harness-import]')).toBe('Import');

      // Skip is an answer: it moves on, and Back brings the same question back.
      await clickOn(h.q('[data-harness-skip]'), 'skip claude');
      expect(step(h)).toBe('codex');
      await clickOn(h.q('[data-stepper-back]'), 'back');
      expect(step(h)).toBe('claude');
      expect(h.q('[data-setup-section="found"]')).not.toBeNull();

      await clickOn(h.q('[data-harness-import]'), 'import claude');
      expect(step(h)).toBe('codex');
      const codex = h.text('[data-first-run-step="codex"]');
      expect(codex).toContain('Same as your CLAUDE.md · one shared copy');
      expect(codex).not.toContain('share this login');
      expect(h.text('[data-setup-note="problem"]')).toBe('Couldn’t read config.toml: it is not valid TOML.');
      // Installed but not signed in: sign in now, or import and sign in later.
      expect(h.text('[data-setup-note="sign-in-now"]')).toContain('Codex isn’t signed in');
      expect(h.text('[data-setup-note="sign-in-now"]')).toContain(
        'Sign in now, or import your setup and sign in later.',
      );
      expect(h.text('[data-harness-import]')).toBe('Import, sign in later');
      await clickOn(h.q('[data-harness-import]'), 'import codex');
      expect(step(h)).toBe('names');
    } finally {
      await h.view.unmount();
    }
  });

  it('skipping both ends on Done with nothing, and Start again goes back to the first question', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
      { mode: 'import', machine: machineView() },
    );
    try {
      await clickOn(h.q('[data-harness-skip]'), 'skip claude');
      await clickOn(h.q('[data-harness-skip]'), 'skip codex');
      expect(h.q('[data-first-run-result="nothing"]')?.textContent).toContain('Nothing was imported');
      expect(h.text()).toContain('That’s fine. Your runtimes are unchanged.');
      await clickOn(h.q('[data-first-run-start-again]'), 'start again');
      expect(step(h)).toBe('claude');
    } finally {
      await h.view.unmount();
    }
  });
});

const LOGIN_PATH = '/v1/fleet/login';
const FLOW_PATH = '/v1/fleet/login/flow-1';
const CREDENTIALS_PATH = '/v1/fleet/credentials';

const codexFlow = (state: 'awaiting-approval' | 'complete') => ({
  harness: 'codex',
  flowId: 'flow-1',
  credentialId: 'codex-you',
  identity: 'codex:you',
  startedAt: '2026-10-13T08:00:00.000Z',
  expiresAt: '2026-10-13T08:10:00.000Z',
  state,
  ...(state === 'awaiting-approval'
    ? { verificationUrl: 'https://auth.openai.com/codex/device', userCode: '0IER-FFQW6' }
    : {}),
});

const ownCodexLogin = credentialView('codex-you', { harness: 'codex', store: 'host', sharedWithTerminal: true });

// One act per slice: a state change inside an act only commits (and so re-arms the poll) when that act ends.
const wait = async (ms: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  await settle();
};

/**
 * Waits until the screen shows what the test expects, one act per slice, for at most two seconds.
 *
 * A fixed count of microtask ticks is not enough here: the sign-in reads a daemon answer's body, which
 * a loaded runner can resolve on a later macrotask, so the state arrived a tick after `settle` gave up.
 */
const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

describe('MachineFirstRun: Sign in now', () => {
  it('makes the own login in place, signs it in, and returns to the same step with it signed in', async () => {
    const calls: Call[] = [];
    let added = false;
    let signedIn = false;
    const signedInScan = scan({
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, account: { state: 'signed-in', email: 'you@example.com' } }],
    });
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: () => (signedIn ? signedInScan : scan()),
        [RUNTIMES_PATH]: runtimes([]),
        [CREDENTIALS_PATH]: () => credentials(added ? [ownCodexLogin] : []),
        [CHANGES_PATH]: (call: Call) => ({ ...STAGED_IMPORT, change: (call.body as { change: unknown }).change }),
        [APPLY_PATH]: () => {
          added = true;
          return EXECUTED;
        },
        [LOGIN_PATH]: codexFlow('awaiting-approval'),
        [FLOW_PATH]: () => {
          signedIn = true;
          return codexFlow('complete');
        },
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-import]'), 'import claude');
      expect(step(h)).toBe('codex');
      await clickOn(h.q('[data-harness-sign-in]'), 'sign in now');
      // The sign-in replaces the step's answers until it is done or put off.
      expect(h.q('[data-first-run-sign-in="codex"]')).not.toBeNull();
      expect(h.q('[data-harness-import]')).toBeNull();
      expect(h.text('[data-first-run-sign-in="codex"]')).toContain(
        'This is your own Codex login on studio-mac: codex in your terminal signs in too.',
      );
      expect(h.text('[data-change-submit]')).toBe('Sign in to Codex');
      await clickOn(h.q('[data-change-submit]'), 'sign in to codex');
      expect(changeBodies(calls)).toEqual([
        { kind: 'credential.add', id: 'codex-you', harness: 'codex', store: 'host' },
      ]);
      expect(calls.find(call => call.path === LOGIN_PATH)?.body).toEqual({ credentialId: 'codex-you' });
      await until(() => h.q('[data-codex-login="awaiting-approval"]') !== null, 'the Codex login awaiting approval');

      await wait(60);
      // Back on the same step, now signed in, and the import is a plain Import.
      expect(step(h)).toBe('codex');
      expect(h.q('[data-first-run-sign-in]')).toBeNull();
      expect(h.q('[data-setup-note="sign-in-now"]')).toBeNull();
      expect(h.text('[data-harness-import]')).toBe('Import');
      await clickOn(h.q('[data-harness-import]'), 'import codex');
      expect(step(h)).toBe('names');
    } finally {
      await h.view.unmount();
    }
  });

  it('reuses an own login that is already there, and Not now puts the sign-in off', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: scan(),
        [RUNTIMES_PATH]: runtimes([]),
        [CREDENTIALS_PATH]: credentials([
          credentialView('codex-you', { harness: 'claude', store: 'host' }),
          ownCodexLogin,
        ]),
        [LOGIN_PATH]: new FyHttpError('a sign-in is already running', 409, 'conflict'),
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-import]'), 'import claude');
      await clickOn(h.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(h.q('[data-change-submit]'), 'sign in to codex');
      // Nothing is made: the machine already points at the person's own Codex login.
      expect(changeBodies(calls)).toEqual([]);
      expect(calls.find(call => call.path === LOGIN_PATH)?.body).toEqual({ credentialId: 'codex-you' });
      await clickOn(h.q('[data-first-run-sign-in-close]'), 'not now');
      expect(h.q('[data-first-run-sign-in]')).toBeNull();
      expect(h.text('[data-harness-import]')).toBe('Import, sign in later');
    } finally {
      await h.view.unmount();
    }
  });

  it('says why the own login could not be made, and starts no sign-in', async () => {
    const calls: Call[] = [];
    const sentence = 'codex-you is already a login on studio-mac';
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: scan(),
        [RUNTIMES_PATH]: runtimes([]),
        [CREDENTIALS_PATH]: credentials([]),
        [CHANGES_PATH]: new FyHttpError(sentence, 409, 'fleet_change_refused'),
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-import]'), 'import claude');
      await clickOn(h.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(h.q('[data-change-submit]'), 'sign in to codex');
      expect(h.text('[data-first-run-sign-in="codex"]')).toContain(sentence);
      expect(calls.some(call => call.path === LOGIN_PATH)).toBe(false);
    } finally {
      await h.view.unmount();
    }
  });

  it('says why the logins could not be read, and starts nothing', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: scan(),
        [RUNTIMES_PATH]: runtimes([]),
        [CREDENTIALS_PATH]: new FyHttpError('the setup could not be read', 409, 'fleet_catalog_unreadable'),
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-import]'), 'import claude');
      await clickOn(h.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(h.q('[data-change-submit]'), 'sign in to codex');
      expect(h.text('[data-first-run-sign-in="codex"] [role="alert"]')).toContain('the setup could not be read');
      expect(calls.some(call => call.path === LOGIN_PATH)).toBe(false);
      await clickOn(h.q('[data-first-run-sign-in-close]'), 'not now');
      expect(h.q('[data-setup-note="sign-in-now"]')).not.toBeNull();
    } finally {
      await h.view.unmount();
    }
  });
});

describe('MachineFirstRun: What changed (O6)', () => {
  const withUpdates = scan({
    updates: [
      { reference: 'mcp/github', sources: ['/home/you/.claude.json'] },
      { reference: 'instructions/default', sources: ['/home/you/.claude/CLAUDE.md'] },
    ],
  });

  it('sends only the ticked updates when no harness is imported', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: withUpdates,
        [RUNTIMES_PATH]: runtimes([]),
        [CHANGES_PATH]: STAGED_IMPORT,
        [APPLY_PATH]: EXECUTED,
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-skip]'), 'skip claude');
      await clickOn(h.q('[data-harness-skip]'), 'skip codex');
      expect(step(h)).toBe('updates');
      const body = h.text('[data-first-run-step="updates"]');
      expect(body).toContain('Some of your setup on studio-mac changed since the last import.');
      expect(body).toContain('Update MCP server · github');
      expect(body).toContain('Changed since the last import: .claude.json.');
      // Nothing ticked: nothing to send, so it only goes on.
      expect(h.q('[data-change-submit]')).toBeNull();
      const tick = (id: string) => h.q(`[data-setup-choice="${id}"] input`);
      await clickOn(tick('mcp/github'), 'tick github');
      await clickOn(tick('instructions/default'), 'tick instructions');
      await clickOn(tick('instructions/default'), 'untick instructions');
      expect(h.q('[data-step-next]')).toBeNull();
      expect(h.text('[data-change-submit]')).toBe('Import the updates');
      await clickOn(h.q('[data-change-submit]'), 'import updates');
      expect(changeBodies(calls)).toEqual([{ kind: 'setup.import', include: [], acceptedUpdates: ['mcp/github'] }]);
      expect(h.q('[data-first-run-result="imported"]')).not.toBeNull();
      expect(h.text('[data-setup-note="import-finished"]')).toContain(
        'No new runtimes were added. Your existing runtimes are unchanged.',
      );
      expect(h.q('[data-setup-note="import-note"]')).toBeNull();
      expect(h.retried).toHaveLength(1);
    } finally {
      await h.view.unmount();
    }
  });

  it('with no update ticked and nothing imported, Continue reaches Done with nothing', async () => {
    const h = await start(
      scriptedClient({
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: withUpdates,
        [RUNTIMES_PATH]: runtimes([]),
      }),
      { mode: 'import', machine: machineView() },
    );
    try {
      await clickOn(h.q('[data-harness-skip]'), 'skip claude');
      await clickOn(h.q('[data-harness-skip]'), 'skip codex');
      await clickOn(h.q('[data-step-next]'), 'continue past updates');
      expect(h.q('[data-first-run-result="nothing"]')).not.toBeNull();
    } finally {
      await h.view.unmount();
    }
  });
});

const toNames = async (h: Harness): Promise<void> => {
  await clickOn(h.q('[data-harness-import]'), 'import claude');
  await clickOn(h.q('[data-harness-import]'), 'import codex');
  expect(step(h)).toBe('names');
};

describe('MachineFirstRun: Name runtimes', () => {
  it('a duplicate is unticked (E15); ticking it adds a second card and the ONE change asks for duplicates', async () => {
    const calls: Call[] = [];
    let created = false;
    const withDuplicate = scan({
      runtimes: [{ harness: 'claude', name: 'claude-default', profile: 'default' }],
      duplicates: [{ harness: 'codex', existing: 'codex-default', suggested: 'codex-default-2' }],
      updates: [{ reference: 'mcp/github', sources: ['/home/you/.claude.json'] }],
    });
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: withDuplicate,
        [RUNTIMES_PATH]: () =>
          runtimes(
            created
              ? [
                  runtimeView('codex-default', { harness: 'codex' }),
                  runtimeView('claude-default'),
                  runtimeView('codex-default-2', {
                    harness: 'codex',
                    credential: { id: 'codex-host', store: 'host', status: 'needs_sign_in' },
                    modelSet: { source: 'harness-default' } as never,
                  }),
                ]
              : [runtimeView('codex-default', { harness: 'codex' })],
          ),
        [CHANGES_PATH]: STAGED_IMPORT,
        [APPLY_PATH]: () => {
          created = true;
          return EXECUTED;
        },
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await clickOn(h.q('[data-harness-import]'), 'import claude');
      await clickOn(h.q('[data-harness-import]'), 'import codex');
      expect(step(h)).toBe('updates');
      expect(h.q('[data-change-submit]')).toBeNull();
      await clickOn(h.q('[data-setup-choice="mcp/github"] input'), 'tick github');
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('names');
      expect(h.text('[data-first-run-step="names"]')).toContain(
        'A runtime is a login plus a profile. It’s what you launch. Name each one.',
      );
      const codexCard = h.q('[data-name-card="codex"]');
      expect(codexCard?.querySelector('[data-name-duplicate]')?.textContent).toBe(
        'codex-default already uses this login and profile.',
      );
      const another = must(
        codexCard?.querySelector('[data-name-add-another]') as HTMLInputElement | null,
        'add another',
      );
      expect(another.checked).toBe(false);
      expect(h.q('[data-name-input="codex"]')).toBeNull();
      expect(h.text('[data-change-submit]')).toBe('Create 1 runtime');
      await clickOn(another, 'add another');
      expect((h.q('[data-name-input="codex"]') as HTMLInputElement).value).toBe('codex-default-2');
      expect(h.text('[data-change-submit]')).toBe('Create 2 runtimes');
      await clickOn(h.q('[data-change-submit]'), 'create');
      expect(changeBodies(calls)).toEqual([
        {
          kind: 'setup.import',
          include: ['claude', 'codex'],
          names: { claude: 'claude-default', codex: 'codex-default-2' },
          acceptedUpdates: ['mcp/github'],
          addDuplicates: true,
        },
      ]);
      // Done: the two runtimes this import made, the sign-in link, and the notes.
      expect(h.text('[data-setup-note="import-ready"]')).toContain('studio-mac is ready');
      expect(h.text('[data-setup-note="import-ready"]')).toContain('2 runtimes created.');
      expect(h.q('[data-setup-row="runtime-codex-default"]')).toBeNull();
      expect(h.text('[data-setup-row="runtime-claude-default"]')).toContain('Claude Code · default profile · opus');
      expect(h.text('[data-setup-row="runtime-codex-default-2"]')).toContain('Codex · default profile');
      expect(h.text('[data-setup-row="runtime-codex-default-2"]')).not.toContain('opus');
      expect(h.text('[data-setup-note="sign-in-later"]')).toContain('codex-default-2 uses a login that needs sign-in.');
      const link = must(h.q('[data-first-run-sign-in="codex-host"]'), 'sign-in link');
      expect(link.getAttribute('href')).toBe('#machines/studio-mac/credentials/codex-host');
      expect(link.textContent).toBe('Sign in for codex-default-2');
      const notes = [...h.view.container.querySelectorAll('[data-setup-note="import-note"]')].map(
        note => note.textContent,
      );
      expect(notes).toEqual([
        'notes needs uvx: install uv on studio-mac and it starts working.',
        'Codex needs sign-in before it launches.',
      ]);
      // No Back or Cancel on Done.
      expect(h.q('[data-stepper-back]')).toBeNull();
      expect(h.q('[data-stepper-cancel]')).toBeNull();
      await clickOn(h.q('[data-first-run-finish]'), 'go to runtimes');
      expect(h.done).toHaveLength(1);
    } finally {
      await h.view.unmount();
    }
  });

  it('a bad name and a clash each say why and offer a suggestion', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': machineAnswer(),
        [SCAN_PATH]: scan(),
        [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]),
        [CHANGES_PATH]: STAGED_IMPORT,
        [APPLY_PATH]: EXECUTED,
      },
      calls,
    );
    const h = await start(client, { mode: 'import', machine: machineView() });
    try {
      await toNames(h);
      const submit = () => h.q('[data-change-submit]') as HTMLButtonElement;
      // The suggestion clashes with a runtime the machine already has.
      expect(h.q('[data-name-input="claude"]')?.getAttribute('aria-invalid')).toBe('true');
      expect(h.text('[data-name-problem="claude"]')).toContain('claude-default is already a runtime on studio-mac.');
      expect(h.text('[data-name-suggestion="claude"]')).toBe('Use claude-default-2');
      expect(h.q('[data-name-problem="codex"]')).toBeNull();
      expect(h.text('[data-name-card="codex"]')).toContain('Letters, digits and dashes.');
      expect(submit().disabled).toBe(true);

      await typeInto(h.q('[data-name-input="claude"]'), 'My Runtime!', 'claude name');
      expect(h.text('[data-name-problem="claude"]')).toContain('Use only letters, digits and dashes.');
      expect(h.text('[data-name-suggestion="claude"]')).toBe('Use my-runtime');
      await clickOn(h.q('[data-name-suggestion="claude"]'), 'use suggestion');
      expect((h.q('[data-name-input="claude"]') as HTMLInputElement).value).toBe('my-runtime');
      expect(h.q('[data-name-problem="claude"]')).toBeNull();

      await typeInto(h.q('[data-name-input="claude"]'), '   ', 'empty name');
      expect(h.text('[data-name-problem="claude"]')).toBe('Give the runtime a name. ');
      expect(h.q('[data-name-suggestion="claude"]')).toBeNull();
      expect(submit().disabled).toBe(true);

      await typeInto(h.q('[data-name-input="claude"]'), 'claude-work', 'good name');
      expect(submit().disabled).toBe(false);
      await clickOn(submit(), 'create');
      expect(changeBodies(calls)).toEqual([
        {
          kind: 'setup.import',
          include: ['claude', 'codex'],
          names: { claude: 'claude-work', codex: 'codex-default' },
        },
      ]);
      // The machine reported none of the new names back: the import finished, nothing new is listed.
      expect(h.q('[data-setup-note="import-finished"]')).not.toBeNull();
      expect(h.q('[data-setup-note="sign-in-later"]')).toBeNull();
      expect(h.view.container.querySelectorAll('[data-setup-note="import-note"]')).toHaveLength(2);
    } finally {
      await h.view.unmount();
    }
  });

  it('a change the daemon refuses shows its sentence and stays on the step', async () => {
    const calls: Call[] = [];
    const sentence = 'Import is not available while a migration is running.';
    const h = await start(
      scriptedClient(
        {
          '/v1/fleet/machine': machineAnswer(),
          [SCAN_PATH]: scan(),
          [RUNTIMES_PATH]: runtimes([]),
          [CHANGES_PATH]: new FyHttpError(sentence, 409, 'fleet_change_refused'),
        },
        calls,
      ),
      { mode: 'import', machine: machineView() },
    );
    try {
      await toNames(h);
      await clickOn(h.q('[data-change-submit]'), 'create');
      expect(changeBodies(calls)).toHaveLength(1);
      expect(h.text('[data-change-refusal]')).toBe(sentence);
      expect(step(h)).toBe('names');
      expect(h.q('[data-first-run-step="done"]')).toBeNull();
      expect(h.retried).toHaveLength(0);
    } finally {
      await h.view.unmount();
    }
  });
});

describe('MachineFirstRun: pausing and leaving', () => {
  it('offline pauses the step (E11) and keeps the progress', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
    );
    try {
      await clickOn(h.q('[data-step-next]'), 'continue');
      expect(step(h)).toBe('claude');
      await h.rerender({ online: false });
      expect(h.text('[data-stepper-paused]')).toContain('studio-mac is asleep or offline');
      expect(h.text('[data-stepper-paused]')).toContain('This is paused. Your progress is kept.');
      expect(step(h)).toBeNull();
      await clickOn(h.q('[data-stepper-retry]'), 'retry');
      expect(h.retried).toHaveLength(1);
      await h.rerender({ online: true });
      expect(step(h)).toBe('claude');
    } finally {
      await h.view.unmount();
    }
  });

  it('Cancel asks first, then Leave setup leaves', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
    );
    try {
      expect(h.text('h3')).toBe('Set up studio-mac');
      await clickOn(h.q('[data-stepper-cancel]'), 'cancel');
      const confirm = h.text('[data-stepper-confirm]');
      expect(confirm).toContain('Leave setup?');
      expect(confirm).toContain('Nothing is imported until the last step. You can set up later from Settings.');
      expect(h.left).toHaveLength(0);
      await clickOn(h.q('[data-stepper-stop]'), 'leave setup');
      expect(h.left).toHaveLength(1);
    } finally {
      await h.view.unmount();
    }
  });

  it('Import again: its Cancel names what stops', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
      { mode: 'import', machine: machineView() },
    );
    try {
      expect(h.text('h3')).toBe('Import again');
      await clickOn(h.q('[data-stepper-cancel]'), 'cancel');
      expect(h.text('[data-stepper-confirm]')).toContain('Stop importing?');
      expect(h.text('[data-stepper-stop]')).toBe('Stop, import nothing');
      await clickOn(h.q('[data-stepper-keep]'), 'keep going');
      expect(step(h)).toBe('claude');
      expect(h.left).toHaveLength(0);
    } finally {
      await h.view.unmount();
    }
  });

  it('Import again leaves from its first step without asking', async () => {
    const h = await start(
      scriptedClient({ '/v1/fleet/machine': machineAnswer(), [SCAN_PATH]: scan(), [RUNTIMES_PATH]: runtimes([]) }),
      { mode: 'import', machine: machineView() },
    );
    try {
      expect(h.text('h3')).toBe('Import again');
      await clickOn(h.q('[data-stepper-back]'), 'back');
      expect(h.left).toHaveLength(1);
      expect(h.q('[data-stepper-confirm]')).toBeNull();
    } finally {
      await h.view.unmount();
    }
  });
});
