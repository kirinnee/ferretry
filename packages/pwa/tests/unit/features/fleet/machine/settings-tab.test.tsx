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
  NOW,
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
    browser: fakeWindow(setup.hash ?? '#machines/studio-mac/settings'),
    now: NOW,
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

  it('a refused Save says why and does not ask the shell to check again', async () => {
    await withTab({ answers: { '/v1/fleet/proposals': new Error('unreachable') } }, async ({ q, retried }) => {
      await click(q('[data-setup-choice="skip"] input'), 'skip radio');
      await click(q('[data-change-submit]'), 'save');
      expect(q('[data-change-refusal]')?.textContent).toContain('didn’t answer');
      expect(retried.count).toBe(0);
    });
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
      expect(browser.location.hash).toBe('#machines/studio-mac/settings/install-codex');
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
        expect(browser.location.hash).toBe('#machines/studio-mac/settings/install-claude');
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

  it('offers Set up before the machine is set up, with Clone beside it', async () => {
    await withTab({ machine: FRESH_MACHINE }, async ({ q, browser }) => {
      const setup = must(q('[data-setup-section="setup"]'), 'setup section');
      expect(setup.querySelector('[data-settings-action="setup"]')?.textContent).toContain('Set up studio-mac');
      expect(setup.querySelector('[data-settings-action="import"]')).toBeNull();
      expect(setup.querySelector('[data-settings-action="clone"]')?.textContent).toContain(
        'Clone from another machine',
      );
      expect(setup.querySelector('[data-settings-action="clone"]')?.textContent).toContain(
        'Logins and history stay behind.',
      );
      await click(setup.querySelector('[data-settings-action="clone"]'), 'clone');
      expect(browser.location.hash).toBe('#machines/studio-mac/settings/clone');
    });
  });

  it('offers Import again once the machine is set up', async () => {
    await withTab({ answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q, browser }) => {
      const setup = must(q('[data-setup-section="setup"]'), 'setup section');
      expect(setup.querySelector('[data-settings-action="setup"]')).toBeNull();
      expect(setup.querySelector('[data-settings-action="import"]')?.textContent).toContain('Import again');
      await click(setup.querySelector('[data-settings-action="import"]'), 'import');
      expect(browser.location.hash).toBe('#machines/studio-mac/settings/import');
      expect(q('[data-first-run-step]')).not.toBeNull();
    });
  });

  it('Set up opens the first run', async () => {
    await withTab({ machine: FRESH_MACHINE, answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q, browser }) => {
      await click(q('[data-settings-action="setup"]'), 'set up');
      expect(browser.location.hash).toBe('#machines/studio-mac/settings/setup');
      expect(q('[data-first-run-step="tools"]')).not.toBeNull();
    });
  });

  it('states the machine facts', async () => {
    await withTab({}, async ({ q }) => {
      const facts = must(q('[data-setup-section="facts"]'), 'facts');
      expect(facts.querySelector('h4')?.textContent).toBe('Machine');
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
      ['setup', '[data-first-run-step="tools"]'],
      ['import', '[data-first-run-step]'],
      ['clone', '[data-clone-step="source"]'],
      ['install-claude', '[data-install-flow="claude"]'],
      ['install-codex', '[data-install-flow="codex"]'],
    ];
    for (const [flow, marker] of flows)
      await withTab({ hash: `#machines/studio-mac/settings/${flow}`, answers }, async ({ q }) => {
        expect(q(marker)).not.toBeNull();
        expect(q('[data-machine-settings]')).toBeNull();
      });
    await withTab({ hash: '#machines/studio-mac/settings/nonsense', answers }, async ({ q }) => {
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
    window.location.hash = '#machines/studio-mac/settings/clone';
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

  it('shows the Settings tab itself when no flow is in the address', async () => {
    const connections = new DaemonConnectionStore({
      connections: [record(STUDIO, 1)],
      selectedDaemonId: STUDIO.daemonId,
    });
    const store = { connections } as unknown as AppStore;
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const saved = window.location.hash;
    window.location.hash = '#machines/studio-mac/settings';
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
