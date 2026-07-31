import { describe, expect, it } from 'bun:test';
import { TaskAssigneeLink, TaskLivenessDot } from '../../../src/features/tasks/task-assignee-link.tsx';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';
import { taskSummary } from '../../support/tasks.ts';

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

const assigned = taskSummary({
  assignee: 'hayden',
  live: { assigneeSessionId: 'sess-1', assigneeName: 'Hayden', assigneeStatus: 'running', assigneeHealth: 'active' },
});

describe('TaskAssigneeLink', () => {
  it('links the proved session under the daemon that owns it', async () => {
    const { container } = await mount(<TaskAssigneeLink daemonId={alpha} task={assigned} />);
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe('/d/daemon-alpha/session/sess-1');
    expect(link?.textContent).toBe('Hayden');
    expect(link?.getAttribute('aria-label')).toBe("Open Hayden's session");
  });

  it('sends the same session id to a different daemon when the host changes daemon', async () => {
    // The regression this exists for: kteam built `/session/<id>` from the id
    // alone, so the identical row on a second paired daemon opened the first
    // daemon's session.
    const { container } = await mount(<TaskAssigneeLink daemonId={beta} task={assigned} />);

    expect(container.querySelector('a')?.getAttribute('href')).toBe('/d/daemon-beta/session/sess-1');
  });

  it('percent-encodes a session id that would otherwise escape its path segment', async () => {
    const task = taskSummary({ assignee: 'x', live: { assigneeSessionId: 'a/b', assigneeName: 'X' } });
    const { container } = await mount(<TaskAssigneeLink daemonId={alpha} task={task} />);

    expect(container.querySelector('a')?.getAttribute('href')).toBe('/d/daemon-alpha/session/a%2Fb');
  });

  it('renders an unresolved stored assignee as plain text, never as a dead link', async () => {
    const { container } = await mount(<TaskAssigneeLink daemonId={alpha} task={taskSummary({ assignee: 'ghost' })} />);

    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-task-assignee]')?.getAttribute('data-task-assignee')).toBe('unresolved');
    expect(container.textContent).toContain('ghost');
  });

  it('marks an unassigned task apart from an unresolved one', async () => {
    const { container } = await mount(<TaskAssigneeLink daemonId={alpha} task={taskSummary()} />);

    expect(container.querySelector('[data-task-assignee]')?.getAttribute('data-task-assignee')).toBe('unassigned');
    expect(container.textContent).toBe('Unassigned');
  });

  it('names the session in the hover title only when there is one to open', async () => {
    const withSession = await mount(<TaskAssigneeLink daemonId={alpha} task={assigned} />);
    const without = await mount(<TaskAssigneeLink daemonId={alpha} task={taskSummary({ assignee: 'ghost' })} />);

    expect(withSession.container.querySelector('[data-task-assignee]')?.getAttribute('title')).toBe(
      'Hayden · running\nSession sess-1',
    );
    expect(without.container.querySelector('[data-task-assignee]')?.getAttribute('title')).toBe(
      'ghost · status unavailable',
    );
  });

  it('drops the trailing state on compact surfaces but keeps the identity', async () => {
    const { container } = await mount(<TaskAssigneeLink daemonId={alpha} task={assigned} showStatus={false} />);

    expect(container.textContent).toBe('Hayden');
  });

  it('hands the destination to its host instead of touching history', async () => {
    const navigated: string[] = [];
    const { container } = await mount(
      <TaskAssigneeLink daemonId={alpha} task={assigned} onNavigate={to => navigated.push(to)} />,
    );

    await interact(() => container.querySelector('a')?.click());

    expect(navigated).toEqual(['/d/daemon-alpha/session/sess-1']);
  });
});

describe('TaskLivenessDot', () => {
  it('breathes only for staleness, and never for a reduced-motion reader', async () => {
    const stale = await mount(<TaskLivenessDot task={taskSummary({ live: { staleness: 'quiet' } })} />);
    const dot = stale.container.querySelector('span');

    expect(dot?.className).toContain('bg-warn');
    expect(dot?.className).toContain('animate-pulse');
    expect(dot?.className).toContain('motion-reduce:animate-none');
  });

  it('reads healthy for a live assignee and muted otherwise', async () => {
    const live = await mount(<TaskLivenessDot task={taskSummary({ live: { assigneeHealth: 'active' } })} />);
    const dead = await mount(<TaskLivenessDot task={taskSummary({ live: { assigneeHealth: 'dead' } })} />);

    expect(live.container.querySelector('span')?.className).toContain('bg-ok');
    expect(dead.container.querySelector('span')?.className).toContain('bg-muted');
    expect(dead.container.querySelector('span')?.className).not.toContain('animate-pulse');
  });

  it('is hidden from assistive tech, because the row already names the state', async () => {
    const { container } = await mount(<TaskLivenessDot task={taskSummary()} />);

    expect(container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });
});
