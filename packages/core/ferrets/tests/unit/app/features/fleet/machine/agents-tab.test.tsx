import { describe, expect, it } from 'bun:test';
import type { FleetMachineView } from '@ferretry/protocol';
import { AgentsTab } from '../../../../../../app/features/fleet/machine/agents-tab.tsx';
import type { MachineTabProps } from '../../../../../../app/features/fleet/shell/machines-surface.tsx';
import { interact, mount, must } from '@ferretry/app/testing';
import {
  APPLY_PATH,
  type Call,
  machineAnswer,
  machineView,
  STAGED,
  STUDIO,
  scriptedClient,
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

interface Setup {
  readonly machine?: FleetMachineView | null;
  readonly checking?: boolean;
  readonly hash?: string;
  readonly answers?: Parameters<typeof scriptedClient>[0];
  readonly daemonPanels?: MachineTabProps['daemonPanels'];
}

interface Context {
  readonly calls: Call[];
  readonly retried: { count: number };
  readonly browser: Window;
  readonly q: (selector: string) => Element | null;
  /** The switch on the row with this title. */
  readonly sw: (label: string) => HTMLElement;
  /** That row's (i) button. */
  readonly info: (label: string) => HTMLElement;
  /** That row's open explanation, or `null` while the (i) is closed. */
  readonly explanation: (label: string) => string | null;
}

const withTab = async (setup: Setup, run: (ctx: Context) => Promise<void>): Promise<void> => {
  const calls: Call[] = [];
  const retried = { count: 0 };
  const browser = fakeWindow(setup.hash ?? '#machines/studio-mac/agents');
  const client = scriptedClient({ '/v1/runtimes/machine': machineAnswer(), ...setup.answers }, calls);
  const view = await mount(
    <AgentsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={setup.machine === undefined ? machineView() : setup.machine}
      online
      checking={setup.checking ?? false}
      onRetry={() => {
        retried.count += 1;
      }}
      createClient={async () => client}
      browser={browser}
      {...(setup.daemonPanels === undefined ? {} : { daemonPanels: setup.daemonPanels })}
    />,
  );
  try {
    await settle();
    const q = (selector: string) => view.container.querySelector(selector);
    await run({
      calls,
      retried,
      browser,
      q,
      sw: label =>
        must(
          view.container.querySelector<HTMLElement>(`[data-switch-row="${label}"] [role="switch"]`),
          `the ${label} switch`,
        ),
      info: label =>
        must(
          view.container.querySelector<HTMLElement>(`[data-switch-row="${label}"] [data-switch-info]`),
          `the ${label} (i) button`,
        ),
      explanation: label =>
        view.container.querySelector(`[data-switch-row="${label}"] [data-switch-explanation]`)?.textContent ?? null,
    });
  } finally {
    await view.unmount();
  }
};

const staged = (calls: readonly Call[]): Call =>
  must(calls.find(call => call.path === '/v1/runtimes/proposals') ?? null, 'the staged change call');

const SAVES = { '/v1/runtimes/proposals': STAGED, [APPLY_PATH]: OUTCOME };

describe('AgentsTab', () => {
  it('holds what agents may do, who supervises them and how they come back, in that order', async () => {
    const asked: string[] = [];
    const daemonPanels: NonNullable<MachineTabProps['daemonPanels']> = (panel, _onOpen, group) => {
      asked.push(group ?? String(panel));
      return <section data-panel-group={group} />;
    };
    await withTab({ machine: machineView({ autoResume: true, agendaMode: true }), daemonPanels }, async ({ q }) => {
      const names = [...(q('[data-agents-tab]')?.children ?? [])].map(
        node => node.getAttribute('data-setup-section') ?? node.getAttribute('data-panel-group') ?? 'unknown',
      );
      expect(names).toEqual([
        'agent-permissions',
        'agent-control',
        'supervision',
        'auto-resume',
        'agenda-mode',
        'conversations',
        'agent-settings',
      ]);
      expect([...new Set(asked)]).toEqual(['supervision', 'agent-settings']);
    });
  });

  it('holds none of the Machine tab’s sections', async () => {
    await withTab({}, async ({ q }) => {
      for (const name of ['tools', 'setup', 'facts']) expect(q(`[data-setup-section="${name}"]`)).toBeNull();
      expect(q('[data-machine-settings]')).toBeNull();
    });
  });

  it('waits for a machine that has not answered, still drawing the Warden', async () => {
    const daemonPanels: NonNullable<MachineTabProps['daemonPanels']> = (_panel, _onOpen, group) => (
      <section data-panel-group={group} />
    );
    await withTab({ machine: null, checking: true, daemonPanels }, async ({ q }) => {
      expect(q('[data-agents-waiting]')?.textContent).toBe('Checking studio-mac…');
      expect(q('[data-panel-group="supervision"]')).not.toBeNull();
      expect(q('[data-agents-tab]')).toBeNull();
    });
    await withTab({ machine: null }, async ({ q }) => {
      expect(q('[data-agents-waiting]')?.textContent).toBe('studio-mac’s agent settings show once it answers.');
    });
  });

  it('shows a panel the address names, even with no answer, and Back returns to the tab', async () => {
    let open: ((panel: string | null) => void) | undefined;
    const daemonPanels: NonNullable<MachineTabProps['daemonPanels']> = (panel, onOpen) => {
      open = onOpen;
      return <section data-panel-shown={panel ?? 'list'} />;
    };
    await withTab(
      { machine: null, hash: '#machines/studio-mac/agents/warden', daemonPanels },
      async ({ q, browser }) => {
        expect(q('[data-panel-shown="warden"]')).not.toBeNull();
        await interact(() => must(open, 'the open callback')(null));
        expect(browser.location.hash).toBe('#machines/studio-mac/agents');
      },
    );
  });

  it('ignores a panel word that belongs to another tab', async () => {
    const daemonPanels: NonNullable<MachineTabProps['daemonPanels']> = (panel, _onOpen, group) => (
      <section data-panel-shown={panel ?? undefined} data-panel-group={group} />
    );
    await withTab({ hash: '#machines/studio-mac/agents/host-checks', daemonPanels }, async ({ q }) => {
      expect(q('[data-panel-shown="host-checks"]')).toBeNull();
      expect(q('[data-agents-tab]')).not.toBeNull();
    });
  });

  describe('Agent permissions', () => {
    it('is one inline pick between both modes, with the chosen mode’s sentence and no Save until the other is chosen', async () => {
      await withTab({}, async ({ q }) => {
        const section = must(q('[data-setup-section="agent-permissions"]'), 'agent permissions');
        expect(section.querySelector('input[type="radio"]')).toBeNull();
        const auto = must(section.querySelector('[data-segment="auto"]'), 'auto segment');
        const skip = must(section.querySelector('[data-segment="skip"]'), 'skip segment');
        expect(auto.textContent).toBe('Auto mode');
        expect(skip.textContent).toBe('Skip all checks');
        expect(skip.getAttribute('title')).toBe('Skip all permission checks');
        expect(auto.getAttribute('aria-pressed')).toBe('true');
        expect(skip.getAttribute('aria-pressed')).toBe('false');
        expect(q('[data-agent-permissions-detail]')?.textContent).toBe(
          'Agents work on their own and stop to ask before anything that looks risky.',
        );
        expect(q('[data-agent-permissions-hint]')?.textContent).toContain('Applies to new sessions.');
        expect(q('[data-change-submit]')).toBeNull();
      });
    });

    it('choosing the other mode offers Save and Keep, and Keep puts the choice back', async () => {
      await withTab({}, async ({ q }) => {
        await click(q('[data-segment="skip"]'), 'skip segment');
        expect(q('[data-segment="skip"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(q('[data-agent-permissions-detail]')?.textContent).toBe(
          'Agents never stop to ask. They can change any file and run any command on studio-mac.',
        );
        expect(q('[data-change-submit]')?.textContent).toBe('Save agent permissions');
        expect(q('[data-agent-permissions-undo]')?.textContent).toBe('Keep Auto mode');
        await click(q('[data-agent-permissions-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
        expect(q('[data-segment="auto"]')?.getAttribute('aria-pressed')).toBe('true');
      });
    });

    it('says how many running sessions keep the old mode, once a change is pending', async () => {
      await withTab({ machine: machineView({ runningSessions: 3 }) }, async ({ q }) => {
        expect(q('[data-setup-note="agent-permissions-running"]')).toBeNull();
        await click(q('[data-segment="skip"]'), 'skip segment');
        expect(q('[data-setup-note="agent-permissions-running"]')?.textContent).toContain(
          '3 running sessions keep the old mode (Auto mode) until restarted.',
        );
        expect(q('[data-agent-permissions-hint]')).toBeNull();
      });
      await withTab({ machine: machineView({ runningSessions: 1 }) }, async ({ q }) => {
        await click(q('[data-segment="skip"]'), 'skip segment');
        expect(q('[data-setup-note="agent-permissions-running"]')?.textContent).toContain(
          '1 running session keeps the old mode (Auto mode) until restarted.',
        );
      });
      await withTab({ machine: machineView({ agentPermissions: 'skip', runningSessions: 2 }) }, async ({ q }) => {
        await click(q('[data-segment="auto"]'), 'auto segment');
        expect(q('[data-setup-note="agent-permissions-running"]')?.textContent).toContain(
          '2 running sessions keep the old mode (Skip all permission checks) until restarted.',
        );
        expect(q('[data-agent-permissions-undo]')?.textContent).toBe('Keep Skip all permission checks');
      });
    });

    it('Save sends the machine.settings change and asks the shell to check the machine again', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls, retried }) => {
        await click(q('[data-segment="skip"]'), 'skip segment');
        await click(q('[data-change-submit]'), 'save');
        expect(JSON.stringify(staged(calls).body)).toContain('"kind":"machine.settings"');
        expect(JSON.stringify(staged(calls).body)).toContain('"agentPermissions":"skip"');
        expect(calls.some(call => call.path === APPLY_PATH)).toBe(true);
        expect(retried.count).toBe(1);
      });
    });

    it('a refused Save says why and does not ask the shell to check again', async () => {
      await withTab({ answers: { '/v1/runtimes/proposals': new Error('unreachable') } }, async ({ q, retried }) => {
        await click(q('[data-segment="skip"]'), 'skip segment');
        await click(q('[data-change-submit]'), 'save');
        expect(q('[data-change-refusal]')?.textContent).toContain('didn’t answer');
        expect(retried.count).toBe(0);
      });
    });

    it('holds no browser settings: a save here carries the mode on', async () => {
      await withTab(
        { machine: machineView({ browserMode: 'window', browserProxy: null }), answers: SAVES },
        async ({ q, calls }) => {
          expect(q('[data-setup-section="browser-mode"]')).toBeNull();
          expect(q('[data-setup-section="browser-proxy"]')).toBeNull();
          await click(q('[data-segment="skip"]'), 'skip segment');
          await click(q('[data-change-submit]'), 'save');
          expect(JSON.stringify(staged(calls).body)).toContain('"browserMode":"window"');
        },
      );
    });
  });

  describe('What agents may control', () => {
    it('shows the three that are on by default and the two that are off, as one-line switches', async () => {
      await withTab({}, async ({ q, sw }) => {
        const group = must(q('[data-agent-control]'), 'the group');
        expect(group.querySelectorAll('[role="switch"]')).toHaveLength(5);
        expect(group.querySelector('input[type="checkbox"]')).toBeNull();
        // One line each: no explanation is on the page until its (i) is opened.
        expect(group.querySelectorAll('[data-switch-explanation]')).toHaveLength(0);
        expect(sw('Terminals').getAttribute('aria-checked')).toBe('true');
        expect(sw('Browsers').getAttribute('aria-checked')).toBe('true');
        expect(sw('Files').getAttribute('aria-checked')).toBe('true');
        expect(sw('Ferretry settings').getAttribute('aria-checked')).toBe('false');
        expect(sw('Page scripts').getAttribute('aria-checked')).toBe('false');
        expect(q('[data-change-submit]')).toBeNull();
      });
    });

    it('Save sends only the one that moved', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls, retried, sw }) => {
        await click(sw('Terminals'), 'terminals switch');
        expect(q('[data-change-submit]')?.textContent).toBe('Save what agents may control');
        await click(q('[data-change-submit]'), 'save agent control');
        expect(staged(calls).body).toEqual({
          change: {
            kind: 'machine.settings',
            agentPermissions: 'auto',
            defaultRuntime: 'claude-default',
            agentControl: {
              terminals: false,
              browsers: true,
              files: true,
              ferretrySettings: false,
              pageScripts: false,
            },
          },
        });
        expect(retried.count).toBe(1);
      });
    });

    it('keeps the Page scripts warning one tap away, and sends it when turned on', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls, sw, info, explanation }) => {
        expect(q('[data-switch-row="Page scripts"] [data-switch-hint]')?.textContent).toBe('Can read site sign-ins');
        expect(explanation('Page scripts')).toBeNull();
        await click(info('Page scripts'), 'page scripts (i)');
        expect(explanation('Page scripts')).toContain('your sign-ins');
        expect(explanation('Page scripts')).toContain('shared agent profile');
        await click(sw('Page scripts'), 'page scripts switch');
        await click(q('[data-change-submit]'), 'save agent control');
        expect(staged(calls).body).toMatchObject({ change: { agentControl: { pageScripts: true } } });
      });
    });

    it('offers Ferretry settings off by default and Save turns it on', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls, sw, info, explanation }) => {
        await click(info('Ferretry settings'), 'Ferretry settings (i)');
        expect(explanation('Ferretry settings')).toContain("an agent's edit that loosens anything still waits for you");
        await click(sw('Ferretry settings'), 'Ferretry settings switch');
        await click(q('[data-change-submit]'), 'save agent control');
        expect(staged(calls).body).toMatchObject({
          change: { agentControl: { terminals: true, ferretrySettings: true, pageScripts: false } },
        });
      });
    });

    it('Undo puts every switch back to how it was', async () => {
      await withTab({}, async ({ q, sw }) => {
        await click(sw('Terminals'), 'terminals switch');
        await click(sw('Files'), 'files switch');
        expect(q('[data-change-submit]')).not.toBeNull();
        await click(q('[data-agent-control-undo]'), 'undo');
        expect(sw('Terminals').getAttribute('aria-checked')).toBe('true');
        expect(sw('Files').getAttribute('aria-checked')).toBe('true');
        expect(q('[data-change-submit]')).toBeNull();
      });
    });
  });

  describe('the (i) on a switch row', () => {
    it('opens and closes the longer explanation, and says so to a screen reader', async () => {
      await withTab({}, async ({ info, explanation }) => {
        const button = info('Terminals');
        expect(button.getAttribute('aria-label')).toBe('More about Terminals');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(explanation('Terminals')).toBeNull();
        await click(button, 'open');
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(explanation('Terminals')).toBe('Open, read and type into session terminals.');
        const controlled = button.getAttribute('aria-controls');
        expect(document.getElementById(controlled ?? '')?.textContent ?? null).toBe(explanation('Terminals'));
        await click(button, 'close');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(explanation('Terminals')).toBeNull();
      });
    });

    it('is a real button and the switch beside it is named by the row title, so both work by keyboard', async () => {
      await withTab({}, async ({ sw, info }) => {
        expect(info('Files').tagName).toBe('BUTTON');
        expect(info('Files').getAttribute('type')).toBe('button');
        expect(sw('Files').tagName).toBe('BUTTON');
        const labelled = sw('Files').getAttribute('aria-labelledby');
        expect(document.getElementById(labelled ?? '')?.textContent).toBe('Files');
      });
    });

    it('opening one does not change the switch or stage a change', async () => {
      await withTab({}, async ({ q, sw, info }) => {
        await click(info('Browsers'), 'open');
        expect(sw('Browsers').getAttribute('aria-checked')).toBe('true');
        expect(q('[data-change-submit]')).toBeNull();
      });
    });

    it('draws each on/off setting as one switch row, its explanation closed', async () => {
      await withTab({ machine: machineView({ autoResume: true, agendaMode: true }) }, async ({ q }) => {
        for (const label of [
          'Terminals',
          'Browsers',
          'Files',
          'Ferretry settings',
          'Page scripts',
          'Resume ferrets after a restart',
          'Agenda mode for new ferrets',
          'Keep in sync',
        ]) {
          const row = must(q(`[data-switch-row="${label}"]`), `the ${label} row`);
          expect(row.querySelectorAll('[role="switch"]')).toHaveLength(1);
          expect(row.querySelector('[data-switch-explanation]')).toBeNull();
        }
      });
    });
  });

  describe('Auto-resume', () => {
    it('is hidden for a daemon that predates it, and never sent one', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls }) => {
        expect(q('[data-setup-section="auto-resume"]')).toBeNull();
        await click(q('[data-segment="skip"]'), 'skip segment');
        await click(q('[data-change-submit]'), 'save');
        expect(JSON.stringify(staged(calls).body)).not.toContain('autoResume');
      });
    });

    it('shows On, and Save sends Off with a way to Keep On', async () => {
      await withTab(
        { machine: machineView({ autoResume: true }), answers: SAVES },
        async ({ q, calls, retried, sw, info, explanation }) => {
          const toggle = sw('Resume ferrets after a restart');
          await click(info('Resume ferrets after a restart'), 'auto-resume (i)');
          expect(explanation('Resume ferrets after a restart')).toContain('ferrets that were running');
          expect(toggle.getAttribute('aria-checked')).toBe('true');
          expect(q('[data-auto-resume-summary]')).toBeNull();
          await click(toggle, 'auto-resume switch');
          expect(q('[data-change-submit]')?.textContent).toBe('Save auto-resume');
          expect(q('[data-auto-resume-undo]')?.textContent).toBe('Keep On');
          await click(q('[data-change-submit]'), 'save');
          expect(JSON.stringify(staged(calls).body)).toContain('"autoResume":false');
          expect(retried.count).toBe(1);
        },
      );
    });

    it('shows Off, undoes a pending switch, and lists what the last restart resumed and could not', async () => {
      const machine = machineView({
        autoResume: false,
        lastAutoResume: {
          at: '2026-10-21T08:00:00.000Z',
          resumed: 5,
          skipped: [{ sessionId: 'abc', reason: 'its runtime is signed out' }],
        },
      });
      await withTab({ machine, answers: { '/v1/runtimes/proposals': new Error('unreachable') } }, async ({ q, sw }) => {
        expect(sw('Resume ferrets after a restart').getAttribute('aria-checked')).toBe('false');
        expect(q('[data-auto-resume-summary]')?.textContent).toContain('Resumed 5 ferrets after restart');
        expect(q('[data-auto-resume-skipped]')?.textContent).toBe(
          'Couldn’t auto-resume abc: its runtime is signed out',
        );
        await click(sw('Resume ferrets after a restart'), 'auto-resume switch');
        await click(q('[data-auto-resume-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
      });
    });

    it('says one ferret in the singular', async () => {
      const machine = machineView({
        autoResume: true,
        lastAutoResume: { at: '2026-10-21T08:00:00.000Z', resumed: 1, skipped: [] },
      });
      await withTab({ machine }, async ({ q }) => {
        expect(q('[data-auto-resume-summary]')?.textContent).toBe('Resumed 1 ferret after restart');
      });
    });
  });

  describe('Agenda mode', () => {
    it('is hidden for a daemon that predates it, and never sent one', async () => {
      await withTab({ answers: SAVES }, async ({ q, calls }) => {
        expect(q('[data-setup-section="agenda-mode"]')).toBeNull();
        await click(q('[data-segment="skip"]'), 'skip segment');
        await click(q('[data-change-submit]'), 'save');
        expect(JSON.stringify(staged(calls).body)).not.toContain('agendaMode');
      });
    });

    it('shows On, and Save sends Off with a way to Keep On', async () => {
      await withTab(
        { machine: machineView({ agendaMode: true }), answers: SAVES },
        async ({ q, calls, retried, sw, info, explanation }) => {
          const toggle = sw('Agenda mode for new ferrets');
          await click(info('Agenda mode for new ferrets'), 'agenda (i)');
          expect(explanation('Agenda mode for new ferrets')).toContain('keep an agenda');
          expect(toggle.getAttribute('aria-checked')).toBe('true');
          await click(toggle, 'agenda switch');
          expect(q('[data-change-submit]')?.textContent).toBe('Save agenda mode');
          expect(q('[data-agenda-mode-undo]')?.textContent).toBe('Keep On');
          await click(q('[data-change-submit]'), 'save');
          expect(JSON.stringify(staged(calls).body)).toContain('"agendaMode":false');
          expect(retried.count).toBe(1);
        },
      );
    });

    it('shows Off and undoes a pending switch', async () => {
      await withTab(
        {
          machine: machineView({ agendaMode: false }),
          answers: { '/v1/runtimes/proposals': new Error('unreachable') },
        },
        async ({ q, sw }) => {
          expect(sw('Agenda mode for new ferrets').getAttribute('aria-checked')).toBe('false');
          await click(sw('Agenda mode for new ferrets'), 'agenda switch');
          await click(q('[data-agenda-mode-undo]'), 'keep');
          expect(q('[data-change-submit]')).toBeNull();
        },
      );
    });
  });

  describe('Conversations › Keep in sync', () => {
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
    const checked = (sw: Context['sw']): string | null => sw('Keep in sync').getAttribute('aria-checked');

    it('shows it on when the file cannot be read, since on is the default', async () => {
      await withTab({}, async ({ sw, info, explanation }) => {
        expect(checked(sw)).toBe('true');
        await click(info('Keep in sync'), 'keep in sync (i)');
        expect(explanation('Keep in sync')).toContain('Read-only; nothing is imported');
      });
    });

    it('shows what machine.yaml says, and ignores a file that does not parse', async () => {
      await withTab({ answers: { [READ]: file('conversations:\n  listComputer: false\n') } }, async ({ sw }) =>
        expect(checked(sw)).toBe('false'),
      );
      await withTab({ answers: { [READ]: file('conversations: [unclosed\n') } }, async ({ sw }) =>
        expect(checked(sw)).toBe('true'),
      );
    });

    it('writes the key against the etag it read when switched off, then back on', async () => {
      let text = '# mine\n';
      const answers = {
        [READ]: () => file(text),
        [WRITE]: (call: Call) => {
          text = (call.body as { text: string }).text;
          return { path: 'machine.yaml', etag: 'etag-2', outcome: 'applied' };
        },
      };
      await withTab({ answers }, async ({ q, calls, sw }) => {
        await click(sw('Keep in sync'), 'switch');
        expect(checked(sw)).toBe('false');
        const put = must(calls.find(call => call.path === WRITE) ?? null, 'put');
        expect(put.headers['if-match']).toBe('etag-1');
        expect(text).toContain('# mine');
        expect(text).toContain('listComputer: false');
        await click(sw('Keep in sync'), 'switch');
        expect(checked(sw)).toBe('true');
        expect(text).toContain('listComputer: true');
        expect(q('[data-keep-in-sync-note]')).toBeNull();
      });
    });

    it('says a held change is not in effect yet', async () => {
      const answers = {
        [READ]: file(''),
        [WRITE]: { path: 'machine.yaml', etag: 'etag-2', outcome: 'pending' },
      };
      await withTab({ answers }, async ({ q, sw }) => {
        await click(sw('Keep in sync'), 'switch');
        expect(q('[data-keep-in-sync-note]')?.textContent).toBe('Saved, but not in effect until you confirm it.');
      });
    });

    it('says so when the file has a problem or the machine refuses', async () => {
      await withTab({ answers: { [READ]: file('conversations: [unclosed\n') } }, async ({ q, sw }) => {
        await click(sw('Keep in sync'), 'switch');
        expect(q('[data-keep-in-sync-note]')?.textContent).toBe(
          'machine.yaml has a problem; fix it in the Files panel first.',
        );
        expect(checked(sw)).toBe('true');
      });
      const refused = { [READ]: file(''), [WRITE]: new Error('The machine said no.') };
      await withTab({ answers: refused }, async ({ q, sw }) => {
        await click(sw('Keep in sync'), 'switch');
        expect(q('[data-keep-in-sync-note]')?.textContent?.length).toBeGreaterThan(0);
        expect(checked(sw)).toBe('true');
      });
    });
  });
});
