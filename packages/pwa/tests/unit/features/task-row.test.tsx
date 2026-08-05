import { describe, expect, it } from 'bun:test';
import { TaskAskOriginMarker, TaskQuickSummary, TaskRow } from '../../../src/features/tasks/task-row.tsx';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';
import { type TaskSummaryOverrides, taskSummary } from '../../support/tasks.ts';

const alpha = daemonId('daemon-alpha');

interface RowOptions {
  readonly task?: TaskSummaryOverrides;
  readonly props?: Partial<Parameters<typeof TaskRow>[0]>;
}

const row = async (options: RowOptions = {}) => {
  const opened: string[] = [];
  const { container } = await mount(
    <TaskRow daemonId={alpha} task={taskSummary(options.task)} onOpen={id => opened.push(id)} {...options.props} />,
  );
  return { container, opened };
};

const shell = (container: HTMLElement): HTMLElement => container.querySelector('[data-task-id]') as HTMLElement;
const badge = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-task-status-badge]');

describe('TaskRow', () => {
  it('paints the rail in the lane tone and names the task in the open action', async () => {
    const { container } = await row({ task: { phase: 'build', status: 'in_progress' } });

    expect(shell(container).getAttribute('data-tone')).toBe('warn');
    expect(shell(container).className).toContain('kt-task-rail');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Open &F12: Fix the transcript scroller',
    );
  });

  it('reports the opened task id to its host', async () => {
    const view = await row();

    await interact(() => view.container.querySelector('button')?.click());

    expect(view.opened).toEqual(['F12']);
  });

  it('offers a discoverable Mark done action only for live work and keeps it separate from opening the row', async () => {
    const marked: string[] = [];
    const live = await row({
      task: { phase: 'live', status: 'live' },
      props: { onMarkDone: task => marked.push(task.id) },
    });
    const nonLive = await row({ props: { onMarkDone: task => marked.push(task.id) } });

    await interact(() =>
      (live.container.querySelector('[aria-label="Mark &F12 done"]') as HTMLButtonElement | null)?.click(),
    );

    expect(live.container.textContent).toContain('Mark done');
    expect(nonLive.container.textContent).not.toContain('Mark done');
    expect(marked).toEqual(['F12']);
    expect(live.opened).toEqual([]);
  });

  it('shows the status badge in a mixed list', async () => {
    const { container } = await row({ task: { phase: 'built', status: 'built' } });

    expect(badge(container)?.textContent).toBe('Built');
  });

  it('drops the badge when the column already names the lane', async () => {
    const { container } = await row({
      task: { phase: 'build', status: 'in_progress' },
      props: { impliedLane: 'in_progress' },
    });

    expect(badge(container)).toBeNull();
  });

  it('drops the badge when a homogeneous list already filters to one status', async () => {
    const { container } = await row({ props: { showStatusBadge: false } });

    expect(badge(container)).toBeNull();
  });

  it('keeps the blocked badge even inside the column it is blocked in', async () => {
    const { container } = await row({
      task: { phase: 'build', status: 'blocked', blocked: true, statusReason: 'waiting on review' },
      props: { impliedLane: 'in_progress' },
    });

    expect(badge(container)?.textContent).toBe('Blocked');
    expect(shell(container).getAttribute('data-tone')).toBe('err');
  });

  it('states the blocking reason and who it waits on', async () => {
    const { container } = await row({
      task: { blocked: true, blockedReason: 'CI is red', blockedBy: ['F9', 'F10'] },
    });

    expect(container.textContent).toContain('CI is red');
    expect(container.textContent).toContain('Blocked by &F9, &F10');
  });

  it('shows a phase note only while the task is not blocked', async () => {
    const note = { statusReason: 'awaiting design sign-off' } as const;
    const open = await row({ task: note });
    const blocked = await row({ task: { ...note, blocked: true, blockedReason: 'CI is red' } });

    expect(open.container.textContent).toContain('Phase note · awaiting design sign-off');
    expect(blocked.container.textContent).not.toContain('Phase note');
  });

  it('lists dependencies and claimed files', async () => {
    const { container } = await row({ task: { dependsOn: ['F1'], files: ['src/a.ts', 'src/b.ts'] } });

    expect(container.textContent).toContain('Depends on &F1');
    expect(container.textContent).toContain('src/a.ts, src/b.ts');
  });

  it('warns about advisory file overlap without calling it a blocker', async () => {
    const { container } = await row({
      props: {
        conflicts: [{ taskId: 'B3', sessionId: 'sess-2', files: ['src/a.ts'], crossSession: true }],
      },
    });

    expect(container.textContent).toContain('Shares files with &B3');
  });

  it('flags staleness with an alarm whose reason is available to a screen reader', async () => {
    const { container } = await row({ task: { live: { staleness: 'assignee-dead' } } });
    const alarm = container.querySelector('.sr-only');

    expect(alarm?.textContent).toContain('no longer live');
    expect(alarm?.parentElement?.getAttribute('title')).toContain('no longer live');
  });

  it('links a pull request out to GitHub in a new tab', async () => {
    const { container } = await row({
      task: { links: { prs: ['https://github.com/kirinnee/ferretry/pull/49'], branch: null, commits: [], docs: [] } },
    });
    const link = container.querySelector('a[target="_blank"]');

    expect(link?.getAttribute('rel')).toBe('noreferrer');
    expect(link?.textContent).toBe('ferretry#49');
    expect(link?.getAttribute('aria-label')).toBe('Open kirinnee/ferretry pull request 49');
  });

  it('links the assignee under the row’s own daemon', async () => {
    const { container } = await row({
      task: { assignee: 'hayden', live: { assigneeSessionId: 'sess-1', assigneeName: 'Hayden' } },
    });

    expect(container.querySelector('[data-task-assignee] a')?.getAttribute('href')).toBe(
      '/d/daemon-alpha/session/sess-1',
    );
  });

  it('drops the whole footer strip when neither an assignee nor a PR is wanted', async () => {
    const { container } = await row({ props: { showAssignee: false } });

    expect(container.querySelector('[data-task-assignee]')).toBeNull();
    expect(shell(container).querySelectorAll(':scope > div').length).toBe(0);
  });

  it('keeps a desktop-only PR strip when the assignee is suppressed', async () => {
    const { container } = await row({
      task: { links: { prs: ['https://github.com/a/b/pull/2'], branch: null, commits: [], docs: [] } },
      props: { showAssignee: false },
    });
    const strip = shell(container).querySelector(':scope > div');

    expect(strip?.className).toContain('hidden sm:flex');
    expect(container.querySelector('[data-task-assignee]')).toBeNull();
  });

  it('marks an agent-originated ask and stays silent about a human one', async () => {
    const agent = await row({ task: { askChars: 20, askSource: 'agent: hayden' } });
    const human = await row({ task: { askChars: 20, askSource: 'slack' } });

    expect(agent.container.querySelector('[data-task-ask-origin]')?.getAttribute('data-task-ask-origin')).toBe('agent');
    expect(human.container.querySelector('[data-task-ask-origin]')).toBeNull();
  });

  it('suppresses the origin marker when every visible row shares one origin', async () => {
    const { container } = await row({
      task: { askChars: 20, askSource: 'agent: hayden' },
      props: { showAskOriginMarker: false },
    });

    expect(container.querySelector('[data-task-ask-origin]')).toBeNull();
  });
});

describe('TaskAskOriginMarker', () => {
  it('names all three origins on a detail surface', async () => {
    for (const [origin, label] of [
      ['agent', 'Agent-originated'],
      ['human', 'Human-asked'],
      ['unknown', 'Ask origin unknown'],
    ] as const) {
      const { container } = await mount(<TaskAskOriginMarker origin={origin} />);
      expect(container.textContent).toBe(label);
      expect(container.querySelector('[data-task-ask-origin]')?.getAttribute('data-task-ask-origin')).toBe(origin);
    }
  });

  it('tints only the agent case, because human-asked is the unremarkable default', async () => {
    const agent = await mount(<TaskAskOriginMarker origin="agent" />);
    const human = await mount(<TaskAskOriginMarker origin="human" />);

    expect(agent.container.querySelector('span')?.className).toContain('bg-accent-soft');
    expect(human.container.querySelector('span')?.className).toContain('bg-surface');
  });

  it('renders nothing compact for a non-agent origin', async () => {
    const { container } = await mount(<TaskAskOriginMarker origin="human" compact />);

    expect(container.textContent).toBe('');
  });
});

describe('TaskQuickSummary', () => {
  it('leads with the state, tinted by that same state', async () => {
    const { container } = await mount(<TaskQuickSummary task={taskSummary({ phase: 'live', status: 'live' })} />);
    const panel = container.querySelector('section');

    expect(panel?.getAttribute('data-tone')).toBe('ok');
    expect(panel?.className).toContain('kt-task-summary');
    expect(container.querySelector('strong')?.textContent).toBe('Live.');
  });

  it('labels itself for assistive tech with an id unique to the task', async () => {
    const { container } = await mount(<TaskQuickSummary task={taskSummary({ id: 'B7' })} />);
    const panel = container.querySelector('section');

    expect(panel?.getAttribute('aria-labelledby')).toBe('task-quick-summary-B7');
    expect(container.querySelector('#task-quick-summary-B7')?.textContent).toBe('Quick summary');
  });

  it('prefers the live assignee name over the stored one', async () => {
    const { container } = await mount(
      <TaskQuickSummary task={taskSummary({ assignee: 'hayden', live: { assigneeName: 'Hayden' } })} />,
    );

    expect(container.textContent).toContain('Assigned to Hayden.');
  });

  it('says Unassigned rather than leaving the sentence out', async () => {
    const { container } = await mount(<TaskQuickSummary task={taskSummary()} />);

    expect(container.textContent).toContain('Unassigned.');
  });

  it('records a blocker with no stated reason rather than showing an empty line', async () => {
    const { container } = await mount(
      <TaskQuickSummary task={taskSummary({ blocked: true, blockedBy: ['F1'], blockedSince: null })} />,
    );

    expect(container.textContent).toContain('Blocked; no reason recorded.');
    expect(container.textContent).toContain('Waiting on &F1.');
  });

  it('dates the block from the recorded instant', async () => {
    const since = new Date(2026, 0, 2, 3, 4, 5).toISOString();
    const { container } = await mount(
      <TaskQuickSummary task={taskSummary({ blocked: true, blockedReason: 'CI', blockedSince: since })} />,
    );

    expect(container.textContent).toContain('Blocked since 2026-01-02 03:04:05.');
  });

  it('carries the phase note and the dependency list', async () => {
    const { container } = await mount(
      <TaskQuickSummary task={taskSummary({ statusReason: 'needs design', dependsOn: ['F3'] })} />,
    );

    expect(container.textContent).toContain('Phase note · needs design');
    expect(container.textContent).toContain('Depends on &F3.');
  });
});
