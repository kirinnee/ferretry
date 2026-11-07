import { describe, expect, it } from 'bun:test';
import type { FleetMachineView } from '@ferretry/protocol';
import {
  MachineSettingsSurface,
  MachineSettingsTab,
  type MachineSettingsTabProps,
  runningSessionsSentence,
} from '../../../../../../app/features/fleet/machine/settings-tab.tsx';
import { type DaemonConnectionRecord, DaemonConnectionStore } from '../../../../../../../../plugins/connections/app/lib/connections.ts';
import { type AppStore, StoreProvider } from '@ferretry/app';
import { interact, mount, must } from '@ferretry/app/testing';
import {
  type Call,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  NOTHING_INSTALLED,
  runtimes,
  runtimeView,
  STUDIO,
  scan,
  scriptedClient,
  WORK,
} from '../setup/setup-support.ts';

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

/** Records every group and panel the tab asks for, and draws a marker for each, with the rows it was handed. */
const panelsSpy = () => {
  const asked: (string | undefined)[] = [];
  let open: ((panel: string | null) => void) | undefined;
  const daemonPanels: NonNullable<MachineSettingsTabProps['daemonPanels']> = (panel, onOpen, group, lead) => {
    asked.push(group ?? panel);
    open = onOpen;
    return panel === undefined ? <ul data-panels-group={group}>{lead}</ul> : <section data-panel-shown={panel} />;
  };
  return { asked, daemonPanels, open: (panel: string | null) => must(open, 'the open callback')(panel) };
};

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

  it('lists the tools and offers Install only for one that is missing', async () => {
    await withTab({}, async ({ q, browser }) => {
      const tools = must(q('[data-setup-section="tools"]'), 'tools');
      expect(tools.querySelector('h4')?.textContent).toBe('Tools');
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

  it('draws one Tools section, never a second one named for the machine', async () => {
    await withTab({}, async ({ container }) => {
      const headings = [...container.querySelectorAll('h4')].map(node => node.textContent);
      expect(headings.filter(text => text?.startsWith('Tools'))).toEqual(['Tools']);
      expect(container.querySelectorAll('[data-setup-section="tools"]')).toHaveLength(1);
    });
    const spy = panelsSpy();
    await withTab({ daemonPanels: spy.daemonPanels }, async ({ q, container }) => {
      // With the panel frame the tool rows are the head of the frame's own Tools list: still one section.
      const tools = must(q('[data-panels-group="tools"]'), 'the Tools group');
      expect(tools.querySelector('[data-setup-row="tool-claude"]')).not.toBeNull();
      expect(tools.querySelector('[data-setup-row="tool-codex"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-setup-row^="tool-"]')).toHaveLength(2);
      expect(container.querySelector('[data-setup-section="tools"]')).toBeNull();
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
      expect(setup.querySelector('[data-settings-action="clone"]')?.getAttribute('title')).toContain(
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

  describe('the daemon panels the Machine tab draws as groups', () => {
    it('asks for Devices & access and Health first, then Tools, Setup, the advanced list and About', async () => {
      const spy = panelsSpy();
      await withTab({ daemonPanels: spy.daemonPanels }, async ({ q }) => {
        expect([...new Set(spy.asked)]).toEqual(['devices-access', 'health', 'tools', 'advanced', 'about']);
        const order = [
          ...(q('[data-machine-settings]')?.querySelectorAll('[data-panels-group], [data-setup-section]') ?? []),
        ].map(node => node.getAttribute('data-panels-group') ?? `section:${node.getAttribute('data-setup-section')}`);
        expect(order).toEqual(['devices-access', 'health', 'tools', 'section:setup', 'advanced', 'about']);
      });
    });

    it('still draws the two groups that matter most while the machine has not answered', async () => {
      const spy = panelsSpy();
      await withTab({ machine: null, checking: true, daemonPanels: spy.daemonPanels }, async ({ q }) => {
        expect(q('[data-machine-settings-waiting]')).not.toBeNull();
        expect(q('[data-panels-group="devices-access"]')).not.toBeNull();
        expect(q('[data-panels-group="health"]')).not.toBeNull();
        expect(q('[data-panels-group="about"]')).toBeNull();
      });
    });

    it('opens one by moving the address, and shows a panel the address names even with no answer', async () => {
      const spy = panelsSpy();
      await withTab({ daemonPanels: spy.daemonPanels }, async ({ q, browser }) => {
        await interact(() => spy.open('host-checks'));
        expect(browser.location.hash).toBe('#machines/studio-mac/machine/host-checks');
        expect(q('[data-panel-shown="host-checks"]')).not.toBeNull();
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

    it('shows the tab for a panel word that belongs to another tab', async () => {
      const spy = panelsSpy();
      for (const panel of ['warden', 'accounts', 'secrets', 'secure-copy'])
        await withTab(
          { hash: `#machines/studio-mac/machine/${panel}`, daemonPanels: spy.daemonPanels },
          async ({ q }) => {
            expect(q('[data-panel-shown]')).toBeNull();
            expect(q('[data-machine-settings]')).not.toBeNull();
          },
        );
    });

    it('treats a panel word as nothing to show when the shell supplies no panels', async () => {
      await withTab({ hash: '#machines/studio-mac/machine/host-checks' }, async ({ q }) => {
        expect(q('[data-machine-settings]')).not.toBeNull();
      });
    });
  });

  it('holds the machine facts in the one About section, not a box of their own', async () => {
    await withTab({}, async ({ q, container }) => {
      expect(q('[data-setup-section="facts"]')).toBeNull();
      expect([...container.querySelectorAll('h4')].map(node => node.textContent)).not.toContain('This machine');
      const facts = must(q('[data-setup-section="about"]'), 'about');
      expect(facts.querySelector('h4')?.textContent).toBe('About');
      expect(facts.textContent).toContain('Namestudio-mac');
      expect(facts.textContent).toContain('StatusOnline');
      expect(facts.textContent).toContain('Runtimes2');
      expect(facts.textContent).toContain('FormatThe new account format');
    });
    await withTab({ machine: FRESH_MACHINE, online: false }, async ({ q }) => {
      const facts = must(q('[data-setup-section="about"]'), 'about');
      expect(facts.textContent).toContain('StatusOffline');
      expect(facts.textContent).toContain('RuntimesNot set up yet');
      expect(facts.textContent).toContain('FormatNot set up yet');
    });
  });

  it('puts the facts at the head of the frame\u2019s About list, so Version and updates shares the section', async () => {
    const spy = panelsSpy();
    await withTab({ daemonPanels: spy.daemonPanels }, async ({ q, container }) => {
      const about = must(q('[data-panels-group="about"]'), 'the About group');
      expect(about.querySelector('[data-about-facts]')?.textContent).toContain('Namestudio-mac');
      expect(container.querySelectorAll('[data-about-facts]')).toHaveLength(1);
      expect(q('[data-setup-section="about"]')).toBeNull();
    });
  });

  it('gives every row the tab draws itself an icon, the same size and slot', async () => {
    await withTab({ answers: { '/v1/fleet/setup/scan': scan() } }, async ({ q }) => {
      const rows = [
        ...(q('[data-setup-section="setup"]')?.querySelectorAll('[data-settings-action]') ?? []),
        ...(q('[data-setup-section="tools"]')?.querySelectorAll('[data-setup-row]') ?? []),
      ];
      expect(rows.map(row => row.getAttribute('data-settings-action') ?? row.getAttribute('data-setup-row'))).toEqual([
        'setup',
        'import',
        'clone',
        'export',
        'tool-claude',
        'tool-codex',
      ]);
      for (const row of rows) {
        const slot = must(row.querySelector('[data-row-icon]'), 'the icon slot');
        expect(slot.className).toContain('w-5');
        expect(slot.querySelector('svg')?.getAttribute('width')).toBe('16');
      }
    });
    await withTab({ machine: FRESH_MACHINE }, async ({ q }) => {
      expect(q('[data-settings-action="setup"] [data-row-icon] svg')).not.toBeNull();
      expect(q('[data-settings-action="clone"] [data-row-icon] svg')).not.toBeNull();
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
