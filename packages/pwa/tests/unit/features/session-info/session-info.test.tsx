/**
 * `SessionInfo`: the six tabs wired to the ports that own their facts. Every read starts only once
 * its own tab is shown and is kept while the panel stays open, which is the whole point of handing it
 * ports rather than values — a test proves the gating directly, by counting reads.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type {
  AnalyticsResponse,
  BrowserStatus,
  ManagedWorktreeView,
  McpInventory,
  SessionRelaunchSettings,
  TerminalListView,
  WardenVerdict,
} from '@ferretry/protocol';
import {
  SessionInfo,
  type SessionInfoPorts,
  type SessionInfoProps,
} from '../../../../src/features/session-info/session-info.tsx';
import { type InfoPlacement, useInfoPlacement } from '../../../../src/features/session-info/use-info-placement.ts';
import { NO_SURFACE_DRIVING } from '../../../../src/features/workspace/use-surface-driving.ts';
import { interact, type Mounted, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';
import { DOCS, fakeSignals, MCP, mcpServer, SKILLS, snapshot } from '../context-rail/context-rail-fixtures.ts';
import { mountSettled, settle } from '../fleet/components/view-support.tsx';

const NOW = Date.parse('2026-10-16T10:00:00.000Z');

const counted = <T,>(answer: () => Promise<T>) => {
  const loader = Object.assign(
    async (_signal: AbortSignal) => {
      loader.calls += 1;
      return await answer();
    },
    { calls: 0 },
  );
  return loader;
};

const WORKTREES: readonly ManagedWorktreeView[] = [];
const VERDICTS: readonly WardenVerdict[] = [
  {
    at: '2026-10-16T09:00:00.000Z',
    targetSession: 'session-a',
    verdict: 'cleared',
    reportPath: '/r/1.json',
  } as WardenVerdict,
];
const ANALYTICS: AnalyticsResponse = {
  kind: 'aggregate',
  aggregation: 'sum',
  query: 'sum',
  results: [],
} as unknown as AnalyticsResponse;

/** Builds a full set of ports, each a loader this test can count, overridable one at a time. */
const portsOf = (overrides: Partial<SessionInfoPorts> = {}): SessionInfoPorts => ({
  worktrees: counted(async () => WORKTREES),
  verdicts: counted(async () => VERDICTS),
  analytics: counted(async () => ANALYTICS),
  folder: {
    agentName: 'Hadi',
    sessionId: 'session-a',
    machineName: 'studio-mac',
    signals: fakeSignals(snapshot()),
    loadMcp: counted(async () => MCP),
    loadSkills: counted(async () => SKILLS),
    loadDocs: counted(async () => DOCS),
    onInsertSkill: () => undefined,
    onOpenFile: () => undefined,
  },
  ...overrides,
});

let mounted: Mounted | undefined;
let placement: InfoPlacement | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  placement = undefined;
});

interface HarnessProps extends Omit<SessionInfoProps, 'placement' | 'now'> {
  readonly initial?: Parameters<typeof useInfoPlacement>[0];
}

function Harness({ initial, ...rest }: HarnessProps) {
  placement = useInfoPlacement(initial);
  return <SessionInfo now={() => NOW} placement={placement} {...rest} />;
}

const show = async (overrides: Partial<HarnessProps> = {}) => {
  mounted = await mountSettled(
    <Harness
      browser={null}
      driving={NO_SURFACE_DRIVING}
      name="Hadi"
      onOpenPage={() => undefined}
      onOpenTerminal={() => undefined}
      ports={portsOf()}
      presentation="panel"
      project={null}
      quota={null}
      terminals={null}
      titleId="info-title"
      view={sessionView('session-a')}
      write={async () => undefined}
      {...overrides}
    />,
  );
  return mounted.container;
};

describe('SessionInfo — reading each port only when its tab is shown', () => {
  it('starts on Overview reading only the worktrees list', async () => {
    const ports = portsOf();
    const root = await show({ ports });
    expect((ports.worktrees as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.verdicts as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.analytics as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.folder.loadMcp as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.folder.loadDocs as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.folder.loadSkills as ReturnType<typeof counted>).calls).toBe(0);
    expect(root.textContent).toContain('Hadi');
  });

  it('reads Runtime’s three loaders only once Runtime is shown, and never again when revisited', async () => {
    const ports = portsOf();
    await show({ ports });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect((ports.folder.loadMcp as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.folder.loadDocs as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.folder.loadSkills as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.worktrees as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.verdicts as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.analytics as ReturnType<typeof counted>).calls).toBe(0);

    await interact(() => placement?.setTab('overview'));
    await settle();
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect((ports.folder.loadMcp as ReturnType<typeof counted>).calls).toBe(1);
  });

  it('reads Usage’s analytics only once Usage is shown', async () => {
    const ports = portsOf();
    await show({ ports });
    await interact(() => placement?.setTab('usage'));
    await settle();
    expect((ports.analytics as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.verdicts as ReturnType<typeof counted>).calls).toBe(0);
  });

  it('reads Signals’ verdicts only once Signals is shown', async () => {
    const ports = portsOf();
    await show({ ports });
    await interact(() => placement?.setTab('signals'));
    await settle();
    expect((ports.verdicts as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.analytics as ReturnType<typeof counted>).calls).toBe(0);
  });

  it('reads nothing extra for Folder or Surfaces — they draw from the live signals port and the driving hook directly', async () => {
    const ports = portsOf();
    await show({ ports });
    await interact(() => placement?.setTab('folder'));
    await settle();
    await interact(() => placement?.setTab('surfaces'));
    await settle();
    expect((ports.worktrees as ReturnType<typeof counted>).calls).toBe(1);
    expect((ports.verdicts as ReturnType<typeof counted>).calls).toBe(0);
    expect((ports.analytics as ReturnType<typeof counted>).calls).toBe(0);
  });
});

describe('SessionInfo — Runtime’s MCP list', () => {
  it('drops Ferretry’s own tools server and the overridden ones, but keeps a server merely named the same', async () => {
    const servers: McpInventory = {
      problems: [],
      servers: [
        mcpServer({ name: 'ferretry', scope: 'ferretry', transport: 'stdio' }),
        mcpServer({ name: 'ferretry', scope: 'user', transport: 'stdio' }),
        mcpServer({ name: 'linear' }),
        mcpServer({ name: 'linear', scope: 'user', shadowedBy: 'project' }),
      ],
    };
    const ports = portsOf({ folder: { ...portsOf().folder, loadMcp: async () => servers } });
    const root = await show({ ports });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    const value = must(root.querySelector('[data-info-row="Other MCP"] .fy-info-row__text'), 'the MCP row’s value');
    expect(value.textContent).toBe('ferretry, linear');
  });

  it('reports a failed Docs read without losing the MCP and Skills reads', async () => {
    const ports = portsOf({
      folder: { ...portsOf().folder, loadDocs: async () => Promise.reject(new Error('fs denied')) },
    });
    const root = await show({ ports });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(must(root.querySelector('[data-info-row="Instruction files"]'), 'instructions').textContent).toContain(
      'fs denied',
    );
    // Four skills listed, one overridden: three are what the ferret loads.
    expect(root.textContent).toContain('3 available');
  });
});

describe('SessionInfo — Usage', () => {
  it('hands Usage the quota and the Open analytics callback', async () => {
    const opened: boolean[] = [];
    const root = await show({
      quota: { fiveHourPercent: 50, fiveHourResetAt: NOW + 47 * 60_000 },
      onOpenAnalytics: () => opened.push(true),
    });
    await interact(() => placement?.setTab('usage'));
    await settle();
    expect(root.textContent).toContain('resets in');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-info-open-analytics]'), 'open analytics').click(),
    );
    expect(opened).toEqual([true]);
  });
});

describe('SessionInfo — Context', () => {
  it('names the tab Context, draws its own sub-tabs and label, starting on Files, and moves with the sub-tab', async () => {
    const root = await show({
      ports: portsOf({
        folder: { ...portsOf().folder, renderFiles: () => <p>a file tree</p>, onAddMcp: () => undefined },
      }),
    });
    await interact(() => placement?.setTab('folder'));
    await settle();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Context');
    expect(root.querySelector('[data-context-rail-body] [role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Context sections',
    );
    expect(
      [...root.querySelectorAll('[data-context-rail-body] [role="tab"]')].map(button => button.textContent),
    ).toEqual(['Files', 'Instructions', 'Skills', 'MCP']);
    expect(root.textContent).toContain('a file tree');

    await interact(() => placement?.setFolderTab('mcp'));
    await settle();
    expect(root.querySelector('[data-context-rail-body] [role="tab"][aria-selected="true"]')?.textContent).toBe('MCP');
  });
});

describe('SessionInfo — Signals', () => {
  it('scopes the Warden’s verdicts to this ferret’s own session id, and badges the Signals tab', async () => {
    const signals = fakeSignals(snapshot());
    const ports = portsOf({ folder: { ...portsOf().folder, signals } });
    const root = await show({ ports, view: sessionView('session-a') });
    expect(root.querySelector('[data-info-signals-count]')?.textContent).toBe('1');

    await interact(() => placement?.setTab('signals'));
    await settle();
    expect(root.textContent).toContain('Left it alone — healthy');
  });
});

describe('SessionInfo — Surfaces', () => {
  it('hands Surfaces the terminals, the browser status and the driving hook', async () => {
    const terminals = { sessionId: 'session-a', terminals: [], limits: {} } as unknown as TerminalListView;
    const browser = { sessionId: 'session-a', state: 'running', pages: [] } as unknown as BrowserStatus;
    const root = await show({ terminals, browser });
    await interact(() => placement?.setTab('surfaces'));
    await settle();
    expect(root.textContent).toContain('No terminals or browser pages yet.');
  });
});

describe('SessionInfo — Overview wiring and optional callbacks', () => {
  it('passes sessions, onRename, onOpenSession and onOpenTasks through when the host hands them in', async () => {
    const parent = sessionView('parent-a');
    const child = sessionView('session-a', { config: { parent: 'parent-a' } });
    const renamed: boolean[] = [];
    const root = await show({
      view: child,
      sessions: [parent, child],
      onRename: () => renamed.push(true),
      onOpenSession: () => undefined,
      onOpenTasks: () => undefined,
    });
    expect(root.querySelector('[data-info-rename]')).not.toBeNull();
    expect(root.querySelector('[data-info-open-tasks]')).not.toBeNull();
  });

  it('draws no Rename, Open-session link or Open-tasks control when the host hands none in', async () => {
    const root = await show({ view: sessionView('session-a', { config: { parent: undefined } }) });
    expect(root.querySelector('[data-info-rename]')).toBeNull();
    expect(root.querySelector('[data-info-open-tasks]')).toBeNull();
  });
});

describe('SessionInfo — runtimeControls and the phone sheet', () => {
  it('draws the host’s model/effort controls on Runtime when given', async () => {
    const root = await show({ runtimeControls: <button type="button">Switch model</button> });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(root.textContent).toContain('Switch model');
  });

  it('shows the host’s passive-learning flag on Runtime', async () => {
    const root = await show({ learning: true });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(root.textContent).toContain('On · instructed to file lessons');
  });

  it('reads the Settings row on Runtime, restarts from it, and re-reads after the restart', async () => {
    const stale: SessionRelaunchSettings = { current: false, reasons: ['settings'] };
    const current: SessionRelaunchSettings = { current: true, reasons: [] };
    let reads = 0;
    const relaunch = counted(async () => {
      reads += 1;
      return reads === 1 ? stale : current;
    });
    const restarts: string[] = [];
    const root = await show({
      ports: portsOf({ relaunch }),
      onRestart: async () => {
        restarts.push('restart');
      },
    });
    expect(relaunch.calls).toBe(0);
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(root.textContent).toContain('Running with older settings — Restart to apply');

    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    await settle();
    expect(restarts).toEqual(['restart']);
    expect(relaunch.calls).toBe(2);
  });

  it('says why the Settings row could not be read', async () => {
    const root = await show({
      ports: portsOf({
        relaunch: async () => {
          throw new Error('no session s1');
        },
      }),
    });
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(root.textContent).toContain('Couldn’t check: no session s1');
  });

  it('draws no Settings row for a host without the read', async () => {
    const root = await show();
    await interact(() => placement?.setTab('runtime'));
    await settle();
    expect(root.querySelector('[data-info-row="Settings"]')).toBeNull();
  });

  it('offers the half/full sheet control only in the sheet presentation', async () => {
    const panel = await show({ presentation: 'panel' });
    expect(panel.querySelector('[data-info-size]')).toBeNull();

    await mounted?.unmount();
    mounted = undefined;
    const sheet = await show({ presentation: 'sheet' });
    expect(sheet.querySelector('[data-info-size]')).not.toBeNull();
  });
});
