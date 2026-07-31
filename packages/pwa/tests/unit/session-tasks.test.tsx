import { describe, expect, test } from 'bun:test';
import { SessionTaskKanban, SessionTaskList, sortSessionTasks } from '../../src/components/session-tasks.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { render, run } from '../support/react.ts';
import { taskSummary } from '../support/tasks.ts';

const alpha = daemonId('daemon-alpha');

describe('session task projections', () => {
  test('puts blocked and stale work before ordinary work, then oldest evidence and explicit order', () => {
    const sorted = sortSessionTasks([
      taskSummary({ id: 'F3', order: 2, updatedAt: '2026-07-03T00:00:00.000Z' }),
      taskSummary({ id: 'F1', blocked: true, blockedSince: '2026-07-04T00:00:00.000Z' }),
      taskSummary({ id: 'F2', live: { staleness: 'quiet' }, updatedAt: '2026-07-02T00:00:00.000Z' }),
      taskSummary({ id: 'F4', order: 1, updatedAt: '2026-07-03T00:00:00.000Z' }),
      taskSummary({ id: 'F5', updatedAt: 'not-a-date' }),
    ]);

    expect(sorted.map(task => task.id)).toEqual(['F1', 'F2', 'F4', 'F3', 'F5']);
  });

  test('renders a daemon-scoped, priority-ordered list and reports its opened task', () => {
    const opened: string[] = [];
    const list = render(
      <SessionTaskList
        daemonId={alpha}
        onOpen={taskId => opened.push(taskId)}
        tasks={[
          taskSummary({ id: 'F2', title: 'Ordinary task' }),
          taskSummary({ id: 'F1', blocked: true, blockedReason: 'Waiting for CI', title: 'Blocked task' }),
        ]}
      />,
    );

    const root = list.root.findByProps({ 'data-task-view': 'list' });
    expect(root.props['aria-label']).toBe('Session tasks');
    expect(root.findAllByProps({ 'data-task-id': 'F1' })[0]?.props['data-tone']).toBe('err');
    run(() => root.findAllByType('button')[0]?.props.onClick());
    expect(opened).toEqual(['F1']);
  });

  test('keeps the empty list honest instead of inventing an empty task card', () => {
    const list = render(<SessionTaskList daemonId={alpha} onOpen={() => {}} tasks={[]} />);

    expect(list.root.findByProps({ className: 'px-3 py-4 text-center text-xs text-muted' }).children).toContain(
      'No matching tasks.',
    );
  });

  test('renders all board lanes, groups work by phase, and preserves blocked state in its implied lane', () => {
    const board = render(
      <SessionTaskKanban
        daemonId={alpha}
        onOpen={() => {}}
        tasks={[
          taskSummary({ id: 'F1', phase: 'design', status: 'designed', title: 'Design flow' }),
          taskSummary({ id: 'F2', blocked: true, phase: 'build', status: 'blocked', title: 'Blocked build' }),
          taskSummary({ id: 'F3', phase: 'done', status: 'done', title: 'Shipped work' }),
        ]}
      />,
    );

    const root = board.root.findByProps({ 'data-task-view': 'kanban' });
    expect(root.props['data-task-layout']).toBe('columns');
    expect(root.findAll(item => item.props['data-task-lane'] !== undefined)).toHaveLength(6);
    expect(
      root.findByProps({ 'aria-label': 'In progress column' }).findByProps({ 'data-task-id': 'F1' }),
    ).toBeDefined();
    expect(
      root.findByProps({ 'data-task-id': 'F2' }).findByProps({ 'data-task-status-badge': true }).props.children,
    ).toBe('Blocked');
    expect(root.findByProps({ 'data-task-id': 'F3' }).findAllByProps({ 'data-task-status-badge': true })).toHaveLength(
      0,
    );
  });

  test('stacks every lane for the narrow reading mode', () => {
    const board = render(<SessionTaskKanban compact daemonId={alpha} onOpen={() => {}} tasks={[]} />);
    const root = board.root.findByProps({ 'data-task-view': 'kanban' });

    expect(root.props['data-task-layout']).toBe('stacked');
    expect(root.props.className).toContain('flex-col');
    expect(root.findAllByProps({ className: 'px-3 py-2 text-xs text-muted' })).toHaveLength(6);
  });
});
