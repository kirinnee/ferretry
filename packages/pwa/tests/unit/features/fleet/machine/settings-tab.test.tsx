import { describe, expect, it } from 'bun:test';
import type { FleetMachineView } from '@ferretry/protocol';
import {
  MachineSettingsSurface,
  MachineSettingsTab,
  type MachineSettingsTabProps,
  runningSessionsSentence,
} from '../../../../../src/features/fleet/machine/settings-tab.tsx';
import { type DaemonConnectionRecord, DaemonConnectionStore } from '../../../../../src/lib/connections.ts';
import { type AppStore, StoreProvider } from '../../../../../src/lib/store.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLY_PATH,
  type Call,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  NOTHING_INSTALLED,
  runtimes,
  runtimeView,
  STAGED,
  STUDIO,
  scan,
  scriptedClient,
  WORK,
} from '../setup/setup-support.ts';

const OUTCOME = { outcome: 'executed', executor: 'setup', summary: 'Saved' };

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const fakeWindow = (hash: string): Window =>
  Object.assign(new EventTarget(), { location: { hash } }) as unknown as Window;

const record = (connection: typeof STUDIO, pairedAt: number): DaemonConnectionRecord => ({
  ...connection,
  pairedAt,
  lastSelectedAt: pairedAt,
});

interface Setup {
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly checking?: boolean;
  readonly hash?: string;
  readonly answers?: Parameters<typeof scriptedClient>[0];
  readonly sources?: readonly DaemonConnectionRecord[];
  readonly daemonPanels?: MachineSettingsTabProps['daemonPanels'];
  readonly onSetUp?: (startAt?: string) => void;
}

const props = (
  setup: Setup,
  calls: Call[],
  retried: { count: number },
): MachineSettingsTabProps & { readonly browser: Window } => {
  const client = scriptedClient({ '/v1/fleet/machine': machineAnswer(), ...setup.answers }, calls);
  return {
    connection: STUDIO,
    machineName: 'studio-mac',
    machine: setup.machine === undefined ? machineView() : setup.machine,
    online: setup.online ?? true,
    checking: setup.checking ?? false,
    onRetry: () => {
      retried.count += 1;
    },
    createClient: async () => client,
    sources: setup.sources ?? [record(WORK, 1)],
    browser: fakeWindow(setup.hash ?? '#machines/studio-mac/machine'),
    ...(setup.daemonPanels === undefined ? {} : { daemonPanels: setup.daemonPanels }),
    ...(setup.onSetUp === undefined ? {} : { onSetUp: setup.onSetUp }),
  };
};

const withTab = async (
  setup: Setup,
  run: (ctx: {
    readonly container: HTMLElement;
    readonly calls: Call[];
    readonly retried: { count: number };
    readonly browser: Window;
    readonly q: (selector: string) => Element | null;
  }) => Promise<void>,
): Promise<void> => {
  const calls: Call[] = [];
  const retried = { count: 0 };
  const tabProps = props(setup, calls, retried);
  const view = await mount(<MachineSettingsTab {...tabProps} />);
  try {
    await settle();
    await run({
      container: view.container,
      calls,
      retried,
      browser: tabProps.browser,
      q: selector => view.container.querySelector(selector),
    });
  } finally {
    await view.unmount();
  }
};

describe('runningSessionsSentence', () => {
  it('says one session keeps, several keep', () => {
    expect(runningSessionsSentence(1, 'auto')).toBe(
      '1 running session keeps the old mode (Auto mode) until restarted.',
    );
    expect(runningSessionsSentence(3, 'skip')).toBe(
      '3 running sessions keep the old mode (Skip all permission checks) until restarted.',
    );
  });
});

describe('MachineSettingsTab', () => {
  it('waits for a machine that has not answered, saying whether it is checking', async () => {
    await withTab({ machine: null, checking: true }, async ({ q }) => {
      expect(q('[data-machine-settings-waiting]')?.textContent).toBe('Checking studio-mac…');
      expect(q('[data-machine-settings]')).toBeNull();
    });
    await withTab({ machine: null }, async ({ q }) => {
      expect(q('[data-machine-settings-waiting]')?.textContent).toBe('studio-mac’s settings show once it answers.');
    });
  });

  it('shows both permission modes with their sentences and no Save until the other is chosen', async () => {
    await withTab({}, async ({ q }) => {
      const section = must(q('[data-setup-section="agent-permissions"]'), 'agent permissions');
      expect(section.querySelector('[data-setup-choice="auto"]')?.textContent).toContain('Auto mode');
      expect(section.querySelector('[data-setup-choice="auto"]')?.textContent).toContain(
        'Agents work on their own and stop to ask before anything that looks risky.',
      );
      expect(section.querySelector('[data-setup-choice="skip"]')?.textContent).toContain('Skip all permission checks');
      expect(section.querySelector('[data-setup-choice="skip"]')?.textContent).toContain(
        'Agents never stop to ask. They can change any file and run any command on studio-mac.',
      );
      expect(section.querySelector<HTMLInputElement>('[data-setup-choice="auto"] input')?.checked).toBe(true);
      expect(q('[data-agent-permissions-hint]')?.textContent).toContain('Applies to new sessions.');
      expect(q('[data-change-submit]')).toBeNull();
    });
  });

  it('choosing the other mode offers Save and Keep, and Keep puts the choice back', async () => {
    await withTab({}, async ({ q }) => {
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      expect(q('[data-setup-choice="skip"] input') as HTMLInputElement).toHaveProperty('checked', true);
      expect(q('[data-change-submit]')?.textContent).toBe('Save agent permissions');
      expect(q('[data-agent-permissions-undo]')?.textContent).toBe('Keep Auto mode');
      await click(q('[data-agent-permissions-undo]'), 'keep');
      expect(q('[data-change-submit]')).toBeNull();
      expect(q('[data-setup-choice="auto"] input') as HTMLInputElement).toHaveProperty('checked', true);
    });
  });

  it('says how many running sessions keep the old mode, once a change is pending', async () => {
    await withTab({ machine: machineView({ runningSessions: 3 }) }, async ({ q }) => {
      expect(q('[data-setup-note="agent-permissions-running"]')).toBeNull();
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      const note = must(q('[data-setup-note="agent-permissions-running"]'), 'running sessions note');
      expect(note.textContent).toContain('3 running sessions keep the old mode (Auto mode) until restarted.');
      expect(q('[data-agent-permissions-hint]')).toBeNull();
    });
    await withTab({ machine: machineView({ runningSessions: 1 }) }, async ({ q }) => {
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      expect(q('[data-setup-note="agent-permissions-running"]')?.textContent).toContain(
        '1 running session keeps the old mode (Auto mode) until restarted.',
      );
    });
    await withTab({ machine: machineView({ agentPermissions: 'skip', runningSessions: 2 }) }, async ({ q }) => {
      await click(q('[data-setup-choice="auto"] input'), 'auto radio');
      expect(q('[data-setup-note="agent-permissions-running"]')?.textContent).toContain(
        '2 running sessions keep the old mode (Skip all permission checks) until restarted.',
      );
      expect(q('[data-agent-permissions-undo]')?.textContent).toBe('Keep Skip all permission checks');
    });
  });

  it('Save sends the machine.settings change and asks the shell to check the machine again', async () => {
    await withTab(
      {
        answers: {
          '/v1/fleet/proposals': STAGED,
          [APPLY_PATH]: OUTCOME,
        },
      },
      async ({ q, calls, retried }) => {
        await click(q('[data-setup-choice="skip"] input'), 'skip radio');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change call',
        );
        expect(JSON.stringify(staged.body)).toContain('"kind":"machine.settings"');
        expect(JSON.stringify(staged.body)).toContain('"agentPermissions":"skip"');
        expect(calls.some(call => call.path === APPLY_PATH)).toBe(true);
        expect(retried.count).toBe(1);
      },
    );
  });

  it('Save asks the shell to re-read the machine QUIETLY when it offers that, not to show "checking"', async () => {
    const calls: Call[] = [];
    const retried = { count: 0 };
    const refreshed = { count: 0 };
    const tabProps = props({ answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME } }, calls, retried);
    const view = await mount(
      <MachineSettingsTab
        {...tabProps}
        onRefresh={() => {
          refreshed.count += 1;
        }}
      />,
    );
    try {
      await settle();
      const q = (selector: string) => view.container.querySelector(selector);
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      expect(refreshed.count).toBe(1);
      expect(retried.count).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it('a refused Save says why and does not ask the shell to check again', async () => {
    await withTab({ answers: { '/v1/fleet/proposals': new Error('unreachable') } }, async ({ q, retried }) => {
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      expect(q('[data-change-refusal]')?.textContent).toContain('didn’t answer');
      expect(retried.count).toBe(0);
    });
  });

  describe('Default runtime for new agents (T)', () => {
    it('says there is nothing to pick yet while the machine has no agent runtime', async () => {
      await withTab({ answers: { '/v1/fleet/runtimes': runtimes([]) } }, async ({ q }) => {
        await settle();
        expect(q('[data-default-runtime-empty]')?.textContent).toContain('has no agent runtime yet');
        expect(q('[data-setup-choices="default-runtime"]')).toBeNull();
      });
    });

    it('offers a picker of agent runtimes, the current one checked, and Save restates agent permissions and agent control untouched', async () => {
      await withTab(
        {
          answers: {
            '/v1/fleet/runtimes': runtimes([runtimeView('claude-default'), runtimeView('claude-review')]),
            '/v1/fleet/proposals': STAGED,
            [APPLY_PATH]: OUTCOME,
          },
        },
        async ({ q, calls, retried }) => {
          await settle();
          const section = must(q('[data-setup-section="default-runtime"]'), 'default runtime section');
          expect(section.querySelector('[data-setup-choice="claude-default"] input')).toHaveProperty('checked', true);
          expect(section.querySelector('[data-setup-choice="claude-review"] input')).toHaveProperty('checked', false);
          expect(q('[data-default-runtime-undo]')).toBeNull();

          await click(q('[data-setup-choice="claude-review"] input'), 'claude-review radio');
          expect(q('[data-default-runtime-undo]')?.textContent).toBe('Keep claude-default');
          await click(q('[data-change-submit]'), 'save default runtime');

          const staged = must(
            calls.find(call => call.path === '/v1/fleet/proposals'),
            'the staged change call',
          );
          expect(staged.body).toEqual({
            change: {
              kind: 'machine.settings',
              agentPermissions: 'auto',
              defaultRuntime: 'claude-review',
              agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
            },
          });
          expect(retried.count).toBe(1);
        },
      );
    });

    it('shows what a machine with no resolvable default looks like, and Keep returns to it', async () => {
      await withTab(
        {
          machine: machineView({ defaultRuntime: null }),
          answers: { '/v1/fleet/runtimes': runtimes([runtimeView('claude-default')]) },
        },
        async ({ q }) => {
          await settle();
          expect(q('[data-setup-choice="claude-default"] input')).toHaveProperty('checked', false);
          expect(q('[data-change-submit]')).toBeNull();
          await click(q('[data-setup-choice="claude-default"] input'), 'claude-default radio');
          expect(q('[data-default-runtime-undo]')?.textContent).toBe('Keep automatic');
          await click(q('[data-default-runtime-undo]'), 'keep automatic');
          expect(q('[data-setup-choice="claude-default"] input')).toHaveProperty('checked', false);
          expect(q('[data-change-submit]')).toBeNull();
        },
      );
    });
  });

  describe('What agents may control (T)', () => {
    it('shows all three switched on by default, and Save sends only the one that moved', async () => {
      await withTab(
        {
          answers: {
            '/v1/fleet/proposals': STAGED,
            [APPLY_PATH]: OUTCOME,
          },
        },
        async ({ q, calls, retried }) => {
          const section = must(q('[data-setup-section="agent-control"]'), 'agent control section');
          expect(section.querySelector('[data-setup-choice="terminals"] input')).toHaveProperty('checked', true);
          expect(section.querySelector('[data-setup-choice="browsers"] input')).toHaveProperty('checked', true);
          expect(section.querySelector('[data-setup-choice="files"] input')).toHaveProperty('checked', true);
          expect(q('[data-change-submit]')).toBeNull();

          await click(q('[data-setup-choice="terminals"] input'), 'terminals checkbox');
          expect(q('[data-change-submit]')?.textContent).toBe('Save what agents may control');
          await click(q('[data-change-submit]'), 'save agent control');

          const staged = must(
            calls.find(call => call.path === '/v1/fleet/proposals'),
            'the staged change call',
          );
          expect(staged.body).toEqual({
            change: {
              kind: 'machine.settings',
              agentPermissions: 'auto',
              defaultRuntime: 'claude-default',
              agentControl: { terminals: false, browsers: true, files: true, ferretrySettings: false },
            },
          });
          expect(retried.count).toBe(1);
        },
      );
    });

    it('Undo puts every switch back to how it was', async () => {
      await withTab({}, async ({ q }) => {
        await click(q('[data-setup-choice="terminals"] input'), 'terminals checkbox');
        await click(q('[data-setup-choice="files"] input'), 'files checkbox');
        expect(q('[data-change-submit]')).not.toBeNull();
        await click(q('[data-agent-control-undo]'), 'undo');
        expect(q('[data-setup-choice="terminals"] input')).toHaveProperty('checked', true);
        expect(q('[data-setup-choice="files"] input')).toHaveProperty('checked', true);
        expect(q('[data-change-submit]')).toBeNull();
      });
    });

    it('offers Ferretry settings as a fourth switch, off by default, and Save turns it on', async () => {
      await withTab({ answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME } }, async ({ q, calls }) => {
        const choice = must(q('[data-setup-choice="ferretrySettings"]'), 'Ferretry settings switch');
        expect(choice.textContent).toContain('Ferretry settings');
        expect(choice.textContent).toContain("an agent's edit that loosens anything still waits for you");
        expect(choice.querySelector('input')).toHaveProperty('checked', false);

        await click(choice.querySelector('input'), 'Ferretry settings checkbox');
        await click(q('[data-change-submit]'), 'save agent control');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change call',
        );
        expect(staged.body).toMatchObject({
          change: { agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true } },
        });
      });
    });
  });

  it('hides Browser mode for a daemon that predates it, and never sends it one', async () => {
    await withTab({ answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME } }, async ({ q, calls }) => {
      expect(q('[data-setup-section="browser-mode"]')).toBeNull();
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      const staged = must(
        calls.find(call => call.path === '/v1/fleet/proposals'),
        'the staged change call',
      );
      expect(JSON.stringify(staged.body)).not.toContain('browserMode');
    });
  });

  it('offers Headless and Real window, and Save sends the chosen Browser mode', async () => {
    await withTab(
      {
        machine: machineView({ browserMode: 'headless' }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls, retried }) => {
        const section = must(q('[data-setup-section="browser-mode"]'), 'browser mode');
        expect(section.querySelector('[data-setup-choice="headless"]')?.textContent).toContain('Headless');
        expect(section.querySelector('[data-setup-choice="window"]')?.textContent).toContain('Real window');
        expect(section.querySelector('[data-setup-choice="window"]')?.textContent).toContain('needs Xvfb');
        expect(section.querySelector<HTMLInputElement>('[data-setup-choice="headless"] input')?.checked).toBe(true);
        expect(q('[data-browser-mode-hint]')?.textContent).toContain(
          'Applies the next time the browser on studio-mac starts.',
        );
        expect(q('[data-change-submit]')).toBeNull();

        await click(q('[data-setup-choice="window"] input'), 'window radio');
        expect(q('[data-change-submit]')?.textContent).toBe('Save browser mode');
        expect(q('[data-browser-mode-undo]')?.textContent).toBe('Keep Headless');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change call',
        );
        expect(JSON.stringify(staged.body)).toContain('"browserMode":"window"');
        expect(JSON.stringify(staged.body)).toContain('"agentPermissions":"auto"');
        expect(retried.count).toBe(1);
      },
    );
  });

  it('keeps a Real window machine’s mode, and Keep puts a pending switch back', async () => {
    await withTab(
      {
        machine: machineView({ browserMode: 'window' }),
        answers: { '/v1/fleet/proposals': new Error('unreachable') },
      },
      async ({ q, retried }) => {
        expect(q('[data-setup-choice="window"] input') as HTMLInputElement).toHaveProperty('checked', true);
        await click(q('[data-setup-choice="headless"] input'), 'headless radio');
        expect(q('[data-browser-mode-undo]')?.textContent).toBe('Keep Real window');
        await click(q('[data-change-submit]'), 'save');
        expect(q('[data-change-refusal]')?.textContent).toContain('didn’t answer');
        expect(retried.count).toBe(0);
        await click(q('[data-browser-mode-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
        expect(q('[data-setup-choice="window"] input') as HTMLInputElement).toHaveProperty('checked', true);
      },
    );
  });

  it('hides Auto-resume for a daemon that predates it, and never sends it one', async () => {
    await withTab({ answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME } }, async ({ q, calls }) => {
      expect(q('[data-setup-section="auto-resume"]')).toBeNull();
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      const staged = must(
        calls.find(call => call.path === '/v1/fleet/proposals'),
        'the staged change call',
      );
      expect(JSON.stringify(staged.body)).not.toContain('autoResume');
    });
  });

  it('shows Auto-resume On, and Save sends Off with a way to Keep On', async () => {
    await withTab(
      {
        machine: machineView({ autoResume: true }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls, retried }) => {
        const section = must(q('[data-setup-section="auto-resume"]'), 'auto-resume');
        expect(section.querySelector('[data-setup-choice="on"]')?.textContent).toContain('ferrets that were running');
        expect(section.querySelector<HTMLInputElement>('[data-setup-choice="on"] input')?.checked).toBe(true);
        expect(q('[data-auto-resume-summary]')).toBeNull();
        await click(q('[data-setup-choice="off"] input'), 'off radio');
        expect(q('[data-change-submit]')?.textContent).toBe('Save auto-resume');
        expect(q('[data-auto-resume-undo]')?.textContent).toBe('Keep On');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change call',
        );
        expect(JSON.stringify(staged.body)).toContain('"autoResume":false');
        expect(retried.count).toBe(1);
      },
    );
  });

  it('shows Off, undoes a pending switch, and lists what the last restart resumed and could not', async () => {
    await withTab(
      {
        machine: machineView({
          autoResume: false,
          lastAutoResume: {
            at: '2026-10-21T08:00:00.000Z',
            resumed: 5,
            skipped: [{ sessionId: 'abc', reason: 'its runtime is signed out' }],
          },
        }),
        answers: { '/v1/fleet/proposals': new Error('unreachable') },
      },
      async ({ q }) => {
        expect(q('[data-setup-choice="off"] input') as HTMLInputElement).toHaveProperty('checked', true);
        expect(q('[data-auto-resume-summary]')?.textContent).toContain('Resumed 5 ferrets after restart');
        expect(q('[data-auto-resume-skipped]')?.textContent).toBe(
          'Couldn’t auto-resume abc: its runtime is signed out',
        );
        await click(q('[data-setup-choice="on"] input'), 'on radio');
        await click(q('[data-auto-resume-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
      },
    );
  });

  it('says one ferret in the singular', async () => {
    await withTab(
      {
        machine: machineView({
          autoResume: true,
          lastAutoResume: { at: '2026-10-21T08:00:00.000Z', resumed: 1, skipped: [] },
        }),
      },
      async ({ q }) => {
        expect(q('[data-auto-resume-summary]')?.textContent).toBe('Resumed 1 ferret after restart');
      },
    );
  });

  it('hides Agenda mode for a daemon that predates it, and never sends it one', async () => {
    await withTab({ answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME } }, async ({ q, calls }) => {
      expect(q('[data-setup-section="agenda-mode"]')).toBeNull();
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      const staged = must(
        calls.find(call => call.path === '/v1/fleet/proposals'),
        'the staged change call',
      );
      expect(JSON.stringify(staged.body)).not.toContain('agendaMode');
    });
  });

  it('shows Agenda mode On, and Save sends Off with a way to Keep On', async () => {
    await withTab(
      {
        machine: machineView({ agendaMode: true }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls, retried }) => {
        const section = must(q('[data-setup-section="agenda-mode"]'), 'agenda-mode');
        expect(section.querySelector('[data-setup-choice="on"]')?.textContent).toContain('keep an agenda');
        expect(section.querySelector<HTMLInputElement>('[data-setup-choice="on"] input')?.checked).toBe(true);
        await click(section.querySelector('[data-setup-choice="off"] input'), 'off radio');
        expect(q('[data-change-submit]')?.textContent).toBe('Save agenda mode');
        expect(q('[data-agenda-mode-undo]')?.textContent).toBe('Keep On');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change call',
        );
        expect(JSON.stringify(staged.body)).toContain('"agendaMode":false');
        expect(retried.count).toBe(1);
      },
    );
  });

  it('shows Agenda mode Off and undoes a pending switch', async () => {
    await withTab(
      {
        machine: machineView({ agendaMode: false }),
        answers: { '/v1/fleet/proposals': new Error('unreachable') },
      },
      async ({ q }) => {
        const section = must(q('[data-setup-section="agenda-mode"]'), 'agenda-mode');
        expect(section.querySelector<HTMLInputElement>('[data-setup-choice="off"] input')?.checked).toBe(true);
        await click(section.querySelector('[data-setup-choice="on"] input'), 'on radio');
        await click(q('[data-agenda-mode-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
      },
    );
  });

  it('lists the tools and offers Install only for one that is missing', async () => {
    await withTab({}, async ({ q, browser }) => {
      const tools = must(q('[data-setup-section="tools"]'), 'tools');
      expect(tools.querySelector('h4')?.textContent).toBe('Tools on studio-mac');
      expect(tools.querySelector('[data-setup-row="tool-claude"]')?.textContent).toContain('Claude Code');
      expect(tools.querySelector('[data-setup-row="tool-claude"]')?.textContent).toContain('Installed');
      expect(tools.querySelector('[data-tool-install="claude"]')).toBeNull();
      expect(tools.querySelector('[data-setup-row="tool-codex"]')?.textContent).toContain('Not installed');
      const install = tools.querySelector<HTMLButtonElement>('[data-tool-install="codex"]');
      expect(install?.textContent).toBe('Install');
      expect(install?.disabled).toBe(false);
      await click(install, 'install codex');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/install-codex');
    });
  });

  it('opens the Claude Code installer from its own row', async () => {
    const machine = machineView({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: false },
        { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
      ],
    });
    await withTab(
      { machine, answers: { '/v1/fleet/setup/scan': NOTHING_INSTALLED } },
      async ({ q, browser, container }) => {
        await click(q('[data-tool-install="claude"]'), 'install claude');
        expect(browser.location.hash).toBe('#machines/studio-mac/machine/install-claude');
        expect(q('[data-install-flow="claude"]')).not.toBeNull();
        expect(container.textContent).toContain('Claude Code isn’t installed on studio-mac. Ferretry can install it.');
      },
    );
  });

  it('cannot start an install while the machine is offline', async () => {
    await withTab({ online: false }, async ({ q }) => {
      expect(q('[data-tool-install="codex"]')?.hasAttribute('disabled')).toBe(true);
      expect(must(q('[data-machine-settings]'), 'settings').textContent).toContain('Offline');
    });
  });

  it('offers Set up before the machine is set up, with Copy and Export beside it', async () => {
    await withTab({ machine: FRESH_MACHINE }, async ({ q, browser }) => {
      const setup = must(q('[data-setup-section="setup"]'), 'setup section');
      expect(setup.querySelector('[data-settings-action="setup"]')?.textContent).toContain('Set up studio-mac');
      expect(setup.querySelector('[data-settings-action="import"]')).toBeNull();
      expect(setup.querySelector('[data-settings-action="clone"]')?.textContent).toContain(
        'Copy settings from another machine…',
      );
      expect(setup.querySelector('[data-settings-action="clone"]')?.textContent).toContain(
        'Secrets come only when you pick them; logins never travel.',
      );
      expect(setup.querySelector('[data-settings-action="export"]')?.textContent).toContain('Export settings');
      await click(setup.querySelector('[data-settings-action="clone"]'), 'clone');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/clone');
    });
  });

  it('keeps New machine setup one tap away, and Import again, once the machine is set up', async () => {
    await withTab({ answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q, browser }) => {
      const setup = must(q('[data-setup-section="setup"]'), 'setup section');
      expect(setup.querySelector('[data-settings-action="setup"]')?.textContent).toContain('New machine setup');
      expect(setup.querySelector('[data-settings-action="setup"]')?.textContent).not.toContain('Set up studio-mac');
      expect(setup.querySelector('[data-settings-action="import"]')?.textContent).toContain('Import again');
      await click(setup.querySelector('[data-settings-action="import"]'), 'import');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/import');
      expect(q('[data-setup-note="setup-moved"]')?.textContent).toContain('Import again is');
    });
  });

  it('Import again calls the shell’s full-screen setup on the Claude Code step', async () => {
    const opened: (string | undefined)[] = [];
    await withTab(
      {
        onSetUp: startAt => {
          opened.push(startAt);
        },
      },
      async ({ q, browser }) => {
        await click(q('[data-settings-action="import"]'), 'import again');
        expect(opened).toEqual(['claude']);
        expect(browser.location.hash).toBe('#machines/studio-mac/machine');
        expect(q('[data-setup-note="setup-moved"]')).toBeNull();
      },
    );
  });

  it('New machine setup on a set-up machine calls the shell’s full-screen setup', async () => {
    const opened: (string | undefined)[] = [];
    await withTab(
      {
        onSetUp: startAt => {
          opened.push(startAt);
        },
      },
      async ({ q, browser }) => {
        await click(q('[data-settings-action="setup"]'), 'new machine setup');
        expect(opened).toEqual([undefined]);
        expect(browser.location.hash).toBe('#machines/studio-mac/machine');
      },
    );
  });

  it('New machine setup shows the full-screen note, with no Open, when the shell offers no full screen', async () => {
    await withTab({ answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q, browser }) => {
      await click(q('[data-settings-action="setup"]'), 'new machine setup');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/setup');
      expect(q('[data-setup-note="setup-moved"]')?.textContent).toContain('New machine setup is');
      expect(q('[data-setup-moved-open]')).toBeNull();
      await click(q('[data-setup-moved-back]'), 'back');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine');
      expect(q('[data-machine-settings]')).not.toBeNull();
    });
  });

  it('an old setup or import link offers Open on the right step, and Back leaves it', async () => {
    for (const [flow, expected] of [
      ['setup', undefined],
      ['import', 'claude'],
    ] as const) {
      const opened: (string | undefined)[] = [];
      await withTab(
        {
          hash: `#machines/studio-mac/machine/${flow}`,
          onSetUp: startAt => {
            opened.push(startAt);
          },
        },
        async ({ q, browser }) => {
          expect(q('[data-setup-note="setup-moved"]')?.textContent).toContain('Setup is a full screen now');
          expect(q('[data-setup-moved-open]')?.textContent).toContain('Open studio-mac’s setup');
          await click(q('[data-setup-moved-open]'), 'open');
          expect(opened).toEqual([expected]);
          await click(q('[data-setup-moved-back]'), 'back');
          expect(browser.location.hash).toBe('#machines/studio-mac/machine');
          expect(q('[data-machine-settings]')).not.toBeNull();
        },
      );
    }
  });

  it('Export settings opens the export flow, and its back button returns to the tab', async () => {
    await withTab({}, async ({ q, browser }) => {
      await click(q('[data-settings-action="export"]'), 'export');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/export');
      expect(q('[data-export-settings]')).not.toBeNull();
      expect(q('[data-machine-settings]')).toBeNull();
      await click(q('[data-export-back]'), 'back');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine');
      expect(q('[data-machine-settings]')).not.toBeNull();
      expect(q('[data-export-settings]')).toBeNull();
    });
  });

  it('Set up opens the full-screen note when the shell offers no full screen', async () => {
    await withTab({ machine: FRESH_MACHINE, answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q, browser }) => {
      await click(q('[data-settings-action="setup"]'), 'set up');
      expect(browser.location.hash).toBe('#machines/studio-mac/machine/setup');
      expect(q('[data-setup-note="setup-moved"]')).not.toBeNull();
    });
  });

  it('a not-set-up machine’s Set up opens the full-screen setup when the shell offers one', async () => {
    const opened: (string | undefined)[] = [];
    await withTab(
      {
        machine: FRESH_MACHINE,
        onSetUp: startAt => {
          opened.push(startAt);
        },
      },
      async ({ q, browser }) => {
        await click(q('[data-settings-action="setup"]'), 'set up');
        expect(opened).toEqual([undefined]);
        // The address is left alone: the first run is a screen of its own, not a flow inside this tab.
        expect(browser.location.hash).toBe('#machines/studio-mac/machine');
        expect(q('[data-setup-note="setup-moved"]')).toBeNull();
        expect(q('[data-machine-settings]')).not.toBeNull();
      },
    );
  });

  describe('the paired daemon’s connection and security panels', () => {
    /** Records every call the tab makes, and draws a marker for the list or the open panel. */
    const panelsSpy = () => {
      const asked: (string | undefined)[] = [];
      let open: ((panel: string | null) => void) | undefined;
      const daemonPanels: NonNullable<MachineSettingsTabProps['daemonPanels']> = (panel, onOpen) => {
        asked.push(panel);
        open = onOpen;
        return panel === undefined ? <ul data-panels-list="" /> : <section data-panel-shown={panel} />;
      };
      return { asked, daemonPanels, open: (panel: string | null) => must(open, 'the open callback')(panel) };
    };

    it('lists them between Setup and About this machine once the machine answers', async () => {
      const spy = panelsSpy();
      await withTab({ daemonPanels: spy.daemonPanels }, async ({ q }) => {
        const list = must(q('[data-machine-settings] [data-panels-list]'), 'the panel list');
        const setup = must(q('[data-setup-section="setup"]'), 'setup');
        const facts = must(q('[data-setup-section="facts"]'), 'facts');
        expect(setup.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
        expect(list.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
        expect(spy.asked.every(panel => panel === undefined)).toBe(true);
      });
    });

    it('still lists them while the machine has not answered, because Host checks matter most then', async () => {
      const spy = panelsSpy();
      await withTab({ machine: null, checking: true, daemonPanels: spy.daemonPanels }, async ({ q }) => {
        expect(q('[data-machine-settings-waiting]')).not.toBeNull();
        expect(q('[data-panels-list]')).not.toBeNull();
      });
    });

    it('opens one by moving the address, and shows a panel the address names even with no answer', async () => {
      const spy = panelsSpy();
      await withTab({ daemonPanels: spy.daemonPanels }, async ({ q, browser }) => {
        await interact(() => spy.open('warden'));
        expect(browser.location.hash).toBe('#machines/studio-mac/machine/warden');
        expect(q('[data-panel-shown="warden"]')).not.toBeNull();
        expect(q('[data-machine-settings]')).toBeNull();
        await interact(() => spy.open(null));
        expect(browser.location.hash).toBe('#machines/studio-mac/machine');
        expect(q('[data-machine-settings]')).not.toBeNull();
      });
      const offline = panelsSpy();
      await withTab(
        {
          machine: null,
          online: false,
          hash: '#machines/studio-mac/machine/host-checks',
          daemonPanels: offline.daemonPanels,
        },
        async ({ q }) => {
          expect(q('[data-panel-shown="host-checks"]')).not.toBeNull();
          expect(q('[data-machine-settings-waiting]')).toBeNull();
          expect(offline.asked).toContain('host-checks');
        },
      );
    });

    it('treats a panel word as nothing to show when the shell supplies no panels', async () => {
      await withTab({ hash: '#machines/studio-mac/machine/warden' }, async ({ q }) => {
        expect(q('[data-machine-settings]')).not.toBeNull();
      });
    });
  });

  it('states the machine facts', async () => {
    await withTab({}, async ({ q }) => {
      const facts = must(q('[data-setup-section="facts"]'), 'facts');
      expect(facts.querySelector('h4')?.textContent).toBe('About this machine');
      expect(facts.textContent).toContain('Namestudio-mac');
      expect(facts.textContent).toContain('StatusOnline');
      expect(facts.textContent).toContain('Runtimes2');
      expect(facts.textContent).toContain('FormatThe new account format');
    });
    await withTab({ machine: FRESH_MACHINE, online: false }, async ({ q }) => {
      const facts = must(q('[data-setup-section="facts"]'), 'facts');
      expect(facts.textContent).toContain('StatusOffline');
      expect(facts.textContent).toContain('RuntimesNot set up yet');
      expect(facts.textContent).toContain('FormatNot set up yet');
    });
  });

  it('renders each flow the address names, and leaving one returns to the tab', async () => {
    const answers = {
      '/v1/fleet/setup/scan': NOTHING_INSTALLED,
      '/v1/fleet/runtimes': runtimes([runtimeView('claude-default')]),
    };
    const flows: readonly [string, string][] = [
      ['setup', '[data-setup-note="setup-moved"]'],
      ['import', '[data-setup-note="setup-moved"]'],
      ['clone', '[data-clone-step="source"]'],
      ['install-claude', '[data-install-flow="claude"]'],
      ['install-codex', '[data-install-flow="codex"]'],
    ];
    for (const [flow, marker] of flows)
      await withTab({ hash: `#machines/studio-mac/machine/${flow}`, answers }, async ({ q }) => {
        expect(q(marker)).not.toBeNull();
        expect(q('[data-machine-settings]')).toBeNull();
      });
    await withTab({ hash: '#machines/studio-mac/machine/nonsense', answers }, async ({ q }) => {
      expect(q('[data-machine-settings]')).not.toBeNull();
    });
  });
});

describe('MachineSettingsSurface', () => {
  it('hands Clone every other paired machine and never the one being set up', async () => {
    const connections = new DaemonConnectionStore({
      connections: [record(STUDIO, 1), record(WORK, 2)],
      selectedDaemonId: STUDIO.daemonId,
    });
    const store = { connections } as unknown as AppStore;
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const saved = window.location.hash;
    window.location.hash = '#machines/studio-mac/machine/clone';
    const view = await mount(
      <StoreProvider store={store}>
        <MachineSettingsSurface
          connection={STUDIO}
          machineName="studio-mac"
          machine={machineView()}
          online
          checking={false}
          onRetry={() => undefined}
          createClient={async () => client}
        />
      </StoreProvider>,
    );
    try {
      await settle();
      const choices = [...view.container.querySelectorAll('[data-setup-choice]')].map(node =>
        node.getAttribute('data-setup-choice'),
      );
      expect(choices).toEqual([WORK.daemonId]);
      expect(view.container.querySelector('[data-setup-note="no-sources"]')).toBeNull();
    } finally {
      await view.unmount();
      window.location.hash = saved;
    }
  });

  it('shows the Machine tab itself when no flow is in the address', async () => {
    const connections = new DaemonConnectionStore({
      connections: [record(STUDIO, 1)],
      selectedDaemonId: STUDIO.daemonId,
    });
    const store = { connections } as unknown as AppStore;
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const saved = window.location.hash;
    window.location.hash = '#machines/studio-mac/machine';
    const view = await mount(
      <StoreProvider store={store}>
        <MachineSettingsSurface
          connection={STUDIO}
          machineName="studio-mac"
          machine={machineView()}
          online
          checking={false}
          onRetry={() => undefined}
          createClient={async () => client}
        />
      </StoreProvider>,
    );
    try {
      await settle();
      expect(view.container.querySelector('[data-machine-settings]')).not.toBeNull();
    } finally {
      await view.unmount();
      window.location.hash = saved;
    }
  });
});

describe('MachineSettingsTab › Conversations › Keep in sync', () => {
  const READ = '/v1/config/file?path=machine.yaml';
  const WRITE = '/v1/config/file';
  const file = (text: string) => ({
    path: 'machine.yaml',
    absolutePath: '/home/you/.ferretry/config/machine.yaml',
    kind: 'machine',
    schema: 'machine',
    exists: true,
    text,
    etag: 'etag-1',
    state: 'ok',
    issues: [],
  });
  const keep = (q: (selector: string) => Element | null): HTMLElement =>
    must(q('[data-keep-in-sync]') as HTMLElement | null, 'switch');

  it('shows it on when the file cannot be read, since on is the default', async () => {
    // Arrange
    const setup: Setup = {};

    // Act / Assert
    await withTab(setup, async ({ q }) => {
      expect(keep(q).getAttribute('aria-checked')).toBe('true');
      expect(q('[data-keep-in-sync-hint]')?.textContent).toContain('Read-only; nothing is imported');
    });
  });

  it('shows what machine.yaml says, and ignores a file that does not parse', async () => {
    // Arrange
    const off: Setup = { answers: { [READ]: file('conversations:\n  listComputer: false\n') } };
    const broken: Setup = { answers: { [READ]: file('conversations: [unclosed\n') } };

    // Act / Assert
    await withTab(off, async ({ q }) => expect(keep(q).getAttribute('aria-checked')).toBe('false'));
    await withTab(broken, async ({ q }) => expect(keep(q).getAttribute('aria-checked')).toBe('true'));
  });

  it('writes the key against the etag it read when switched off, then back on', async () => {
    // Arrange
    let text = '# mine\n';
    const answers = {
      [READ]: () => file(text),
      [WRITE]: (call: Call) => {
        text = (call.body as { text: string }).text;
        return { path: 'machine.yaml', etag: 'etag-2', outcome: 'applied' };
      },
    };

    // Act / Assert
    await withTab({ answers }, async ({ q, calls }) => {
      await click(keep(q), 'switch');
      expect(keep(q).getAttribute('aria-checked')).toBe('false');
      const put = must(calls.find(call => call.path === WRITE) ?? null, 'put');
      expect(put.headers['if-match']).toBe('etag-1');
      expect(text).toContain('# mine');
      expect(text).toContain('listComputer: false');
      await click(keep(q), 'switch');
      expect(keep(q).getAttribute('aria-checked')).toBe('true');
      expect(text).toContain('listComputer: true');
      expect(q('[data-keep-in-sync-note]')).toBeNull();
    });
  });

  it('says a held change is not in effect yet', async () => {
    // Arrange
    const answers = {
      [READ]: file(''),
      [WRITE]: { path: 'machine.yaml', etag: 'etag-2', outcome: 'pending' },
    };

    // Act / Assert
    await withTab({ answers }, async ({ q }) => {
      await click(keep(q), 'switch');
      expect(q('[data-keep-in-sync-note]')?.textContent).toBe('Saved, but not in effect until you confirm it.');
    });
  });

  it('says so when the file has a problem or the machine refuses', async () => {
    // Arrange
    const broken: Setup = { answers: { [READ]: file('conversations: [unclosed\n') } };
    const refused: Setup = { answers: { [READ]: file(''), [WRITE]: new Error('The machine said no.') } };

    // Act / Assert
    await withTab(broken, async ({ q }) => {
      await click(keep(q), 'switch');
      expect(q('[data-keep-in-sync-note]')?.textContent).toBe(
        'machine.yaml has a problem; fix it in the Files panel first.',
      );
      expect(keep(q).getAttribute('aria-checked')).toBe('true');
    });
    await withTab(refused, async ({ q }) => {
      await click(keep(q), 'switch');
      expect(q('[data-keep-in-sync-note]')?.textContent?.length).toBeGreaterThan(0);
      expect(keep(q).getAttribute('aria-checked')).toBe('true');
    });
  });
});
