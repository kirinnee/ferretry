import { describe, expect, it } from 'bun:test';
import type { LearningScanProgress, LearningScanRequest } from '@ferretry/protocol';
import { ScanDialog, type ScanDialogProps } from '../../../../src/features/learning/scan-dialog.tsx';
import type { LearningScanControl } from '../../../../src/features/learning/use-learning-scan.ts';
import type { PickerAccount } from '../../../../src/lib/account-picker-catalog.ts';
import { interact, mount, must, pressKey } from '../../../support/dom.ts';
import { estimate, fakeLearningDaemon, learningDaemon, progress } from '../../../support/learning.ts';
import { byText, choose, click, textOf, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const SESSIONS = [
  sessionView('session-hadi', { config: { teammate: 'hadi', cwd: '/work/ferretry' } }),
  sessionView('session-kofi', { config: { teammate: 'kofi', cwd: '/work/home-manager' } }),
];

const ACCOUNTS: readonly PickerAccount[] = [
  {
    id: 'claude-default',
    wrapper: 'claude-default',
    displayName: 'Claude default',
    kind: 'claude',
    agent: true,
    credentialId: 'c',
    defaultModel: 'haiku',
    models: [
      { id: 'haiku', available: true },
      { id: 'opus', available: false },
    ],
    available: true,
    unavailableReason: null,
  },
  {
    id: 'glm',
    wrapper: 'glm-env',
    displayName: 'GLM',
    kind: 'claude',
    agent: true,
    credentialId: 'g',
    defaultModel: null,
    models: [{ id: 'glm-5', available: true }],
    available: false,
    unavailableReason: 'signed out',
  },
  {
    id: 'tool',
    wrapper: 'tool',
    displayName: 'Not an agent',
    kind: 'claude',
    agent: false,
    credentialId: 't',
    defaultModel: null,
    models: [],
    available: true,
    unavailableReason: null,
  },
];

const control = (
  scan: LearningScanProgress | null,
  overrides: Partial<LearningScanControl> = {},
): LearningScanControl & { started: LearningScanRequest[] } => {
  const started: LearningScanRequest[] = [];
  return {
    scan,
    start: async request => {
      started.push(request);
      return progress();
    },
    cancel: async () => undefined,
    started,
    ...overrides,
  };
};

const NOW = new Date(2026, 9, 16, 12).getTime();

const dialog = async (props: Partial<ScanDialogProps> = {}, lessons = fakeLearningDaemon()) => {
  const closed: string[] = [];
  const view = await mount(
    <ScanDialog
      connection={learningDaemon}
      fetcher={lessons.fetch}
      control={control(null)}
      onClose={() => closed.push('close')}
      onView={() => closed.push('view')}
      sessions={SESSIONS}
      projects={[]}
      accounts={ACCOUNTS}
      defaultAgent="claude-default"
      passive={new Set(['session-hadi'])}
      now={() => NOW}
      estimateDelayMs={0}
      {...props}
    />,
  );
  return { view, closed, daemon: lessons };
};

const startButton = (root: ParentNode) => byText<HTMLButtonElement>(root, 'button', 'Start scan');
const estimates = (daemon: ReturnType<typeof fakeLearningDaemon>) =>
  daemon.calls.filter(call => call.path === '/v1/learning/scan/estimate').map(call => call.body);

describe('the scan dialog', () => {
  it('estimates the default scope, names who is in it, and starts only on the button', async () => {
    const started = control(null);
    const { view, daemon } = await dialog({ control: started });
    expect(startButton(view.container).disabled).toBe(true);
    await waitForText(view.container, 'In scope: Hadi, Kofi');
    expect(textOf(view.container)).toContain('2 ferrets · ~320K tokens · ~$0.32');
    expect(textOf(view.container)).toContain('An estimate, run by claude-default. Nothing runs until you press Start.');
    expect(estimates(daemon)).toEqual([{ scope: { kind: 'not-passive' } }]);
    expect(started.started).toEqual([]);
    await click(startButton(view.container));
    expect(started.started).toEqual([{ scope: { kind: 'not-passive' } }]);
    const panel = must(view.container.querySelector('[role="dialog"]'), 'dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(
      must(document.getElementById(must(panel.getAttribute('aria-labelledby'), 'label')), 'title').textContent,
    ).toBe('Scan for lessons');
    await view.unmount();
  });

  it('re-estimates for a new login and model, and says when a price is unknown', async () => {
    const lessons = fakeLearningDaemon();
    lessons.state.estimate = estimate({
      usd: undefined,
      model: 'glm-5',
      skipped: 1,
      beyondLimit: 3,
      sessionIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      sessions: 8,
    });
    const { view, daemon } = await dialog({}, lessons);
    await waitForText(view.container, 'cost unknown');
    expect(textOf(view.container)).toContain(', and 2 more');
    expect(textOf(view.container)).toContain('1 skipped: no transcript to read.');
    expect(textOf(view.container)).toContain('3 more beyond this scan’s limit — scan again for them.');
    expect(textOf(view.container)).toContain('run by claude-default on glm-5');
    const [login, model] = [...view.container.querySelectorAll('select')];
    expect([...must(login, 'login').options].map(option => option.textContent)).toEqual([
      'Machine default (claude-default)',
      'Claude default',
      'GLM',
    ]);
    // The machine default's own models are offered, the unavailable one left out.
    expect([...must(model, 'model').options].map(option => option.textContent)).toEqual([
      'Login’s default (haiku)',
      'haiku',
    ]);
    await choose(must(model, 'model'), 'haiku');
    await waitFor(() => estimates(daemon).length === 2, 'a second estimate');
    await choose(must(login, 'login'), 'glm-env');
    await waitFor(() => estimates(daemon).length === 3, 'a third estimate');
    expect(estimates(daemon).at(-1)).toEqual({ scope: { kind: 'not-passive' }, agent: 'glm-env' });
    expect([...must(view.container.querySelectorAll('select')[1], 'model').options].map(o => o.textContent)).toEqual([
      'Login’s default',
      'glm-5',
    ]);
    await view.unmount();
  });

  it('builds a date range, a project list and a ferret list into the scope it estimates', async () => {
    const { view, daemon } = await dialog({ projects: [{ name: 'ferretry', path: '/work/ferretry' }] });
    await waitFor(() => estimates(daemon).length === 1, 'the first estimate');
    await click(must(view.container.querySelector('input[value="range"]'), 'range'));
    await waitFor(() => estimates(daemon).length === 2, 'the range estimate');
    const range = estimates(daemon).at(-1) as LearningScanRequest;
    expect(range.scope.kind).toBe('range');
    const [from] = [...view.container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(from, '2026-10-30');
      must(from, 'from').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForText(view.container, 'The first day must come before the last.');
    expect(startButton(view.container).disabled).toBe(true);
    const to = must(view.container.querySelectorAll<HTMLInputElement>('input[type="date"]')[1], 'to');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(to, '2026-10-31');
      to.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(() => estimates(daemon).length === 3, 'the moved range estimate');

    await click(must(view.container.querySelector('input[value="projects"]'), 'projects'));
    await waitForText(view.container, 'Pick at least one project.');
    await click(byText(view.container, 'label', 'ferretry').querySelector('input') as HTMLInputElement);
    await waitFor(() => estimates(daemon).length === 4, 'the project estimate');
    expect(estimates(daemon).at(-1)).toEqual({ scope: { kind: 'projects', projects: ['/work/ferretry'] } });

    await click(must(view.container.querySelector('input[value="sessions"]'), 'sessions'));
    await waitForText(view.container, 'Pick at least one ferret.');
    expect(textOf(view.container)).toContain('home-manager · learning off');
    await click(byText(view.container, 'label', 'Kofi').querySelector('input') as HTMLInputElement);
    await waitFor(() => estimates(daemon).length === 5, 'the ferret estimate');
    expect(estimates(daemon).at(-1)).toEqual({ scope: { kind: 'sessions', sessionIds: ['session-kofi'] } });
    await view.unmount();
  });

  it('opens on one ferret, offers folders when no project is registered, and says when nothing is there', async () => {
    const first = await dialog({ initialScope: { kind: 'sessions', sessionIds: ['gone-session-id'] } });
    await waitFor(() => estimates(first.daemon).length === 1, 'the estimate');
    expect(estimates(first.daemon)[0]).toEqual({ scope: { kind: 'sessions', sessionIds: ['gone-session-id'] } });
    expect(textOf(first.view.container)).toContain('gone-ses…');
    await click(must(first.view.container.querySelector('input[value="projects"]'), 'projects'));
    expect(textOf(first.view.container)).toContain('/work/home-manager');
    await first.view.unmount();

    const lessons = fakeLearningDaemon();
    lessons.state.estimate = estimate({ sessions: 0, sessionIds: [], usd: 0 });
    const empty = await dialog({ sessions: null, accounts: null, defaultAgent: undefined }, lessons);
    await waitForText(empty.view.container, 'Nothing to read in this scope.');
    expect(startButton(empty.view.container).disabled).toBe(true);
    expect(must(empty.view.container.querySelector('select'), 'login').textContent).toBe('Machine default');
    await click(must(empty.view.container.querySelector('input[value="projects"]'), 'projects'));
    expect(textOf(empty.view.container)).toContain('No projects on this machine yet.');
    await click(must(empty.view.container.querySelector('input[value="sessions"]'), 'sessions'));
    expect(textOf(empty.view.container)).toContain('No ferrets on this machine.');
    await empty.view.unmount();
  });

  it('says why an estimate or a start failed', async () => {
    const lessons = fakeLearningDaemon();
    lessons.once('POST /v1/learning/scan/estimate', { status: 400, body: { error: 'no such login' } });
    const refused = control(null, {
      start: async () => {
        throw new Error('A scan is already running.');
      },
    });
    const { view } = await dialog({ control: refused }, lessons);
    await waitForText(view.container, 'Could not estimate this scan: no such login');
    expect(startButton(view.container).disabled).toBe(true);
    await click(must(view.container.querySelector('input[value="range"]'), 'range'));
    await waitForText(view.container, 'Nothing runs until you press Start.');
    await click(startButton(view.container));
    await waitForText(view.container, 'A scan is already running.');
    await view.unmount();
  });

  it('shows a running scan’s progress, hides, cancels, and reports a cancel that failed', async () => {
    const cancelled: string[] = [];
    const running = control(progress({ total: 4, done: 2 }), {
      cancel: async () => {
        cancelled.push('cancel');
        if (cancelled.length === 1) throw new Error('could not cancel');
      },
    });
    const { view, closed } = await dialog({ control: running });
    const bar = must(view.container.querySelector('[role="progressbar"]'), 'bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(textOf(view.container)).toContain('Reading ferret 3 of 4… 50%');
    await click(byText(view.container, 'button', 'Cancel scan'));
    await waitForText(view.container, 'could not cancel');
    await click(byText(view.container, 'button', 'Cancel scan'));
    expect(cancelled).toEqual(['cancel', 'cancel']);
    await click(byText(view.container, 'button', 'Hide'));
    expect(closed).toEqual(['close']);

    // The same run ending is shown here as its result.
    await view.render(
      <ScanDialog
        connection={learningDaemon}
        fetcher={fakeLearningDaemon().fetch}
        control={control(progress({ state: 'cancelled', done: 2 }))}
        onClose={() => closed.push('close')}
        onView={() => closed.push('view')}
        sessions={SESSIONS}
        projects={[]}
        accounts={ACCOUNTS}
        passive={new Set()}
      />,
    );
    await waitForText(view.container, 'Scan cancelled.');
    expect(
      must(view.container.querySelector('[role="dialog"]'), 'dialog').getAttribute('data-learning-scan-dialog'),
    ).toBe('finished');
    await click(byText(view.container, 'button', 'Close'));
    await click(byText(view.container, 'button', 'View in Learning'));
    expect(closed).toEqual(['close', 'close', 'view']);
    await view.unmount();
  });

  it('shows the form for a scan that ended before the dialog opened, and closes on Escape or the scrim', async () => {
    const { view, closed } = await dialog({ control: control(progress({ state: 'finished' })) });
    expect(
      must(view.container.querySelector('[role="dialog"]'), 'dialog').getAttribute('data-learning-scan-dialog'),
    ).toBe('form');
    await interact(() => pressKey(document, 'Escape'));
    await click(must(view.container.querySelector('button[tabindex="-1"]'), 'scrim'));
    await click(must(view.container.querySelector('header button[aria-label="Close"]'), 'close'));
    await click(byText(view.container, 'footer button', 'Cancel'));
    expect(closed).toEqual(['close', 'close', 'close', 'close']);
    await view.unmount();
  });
});
