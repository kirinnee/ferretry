import { describe, expect, it } from 'bun:test';
import { filterTaskDag, layoutTaskDag, taskDag, taskTitlePreview } from '../../../src/features/tasks/task-dag.ts';
import { taskSummary } from '../../support/tasks.ts';

describe('taskDag', () => {
  it('keeps absent dependencies visible instead of creating a false root', () => {
    const dag = taskDag([taskSummary({ id: 'F1', dependsOn: ['B9'] })]);

    expect(dag.nodes.map(node => [node.id, node.missing])).toEqual([
      ['F1', false],
      ['B9', true],
    ]);
    expect(dag.edges).toEqual([{ from: 'F1', to: 'B9' }]);
  });

  it('marks only other sessions as cross-session in a session surface', () => {
    const dag = taskDag(
      [
        taskSummary({ id: 'F1', sessionId: 'session-a' } as never),
        taskSummary({ id: 'F2', sessionId: 'session-b' } as never),
      ],
      'session-a',
    );

    expect(dag.nodes.map(node => [node.id, node.crossSession])).toEqual([
      ['F1', false],
      ['F2', true],
    ]);
  });
});

describe('filterTaskDag', () => {
  const dag = taskDag([
    taskSummary({ id: 'F1', status: 'in_progress', phase: 'build', dependsOn: ['B2'] }),
    taskSummary({ id: 'B2', status: 'todo', dependsOn: ['C3'] }),
    taskSummary({ id: 'C3', kind: 'chore', status: 'done', phase: 'done' }),
    taskSummary({ id: 'F4', status: 'todo' }),
  ]);

  it('retains the whole dependency path while hiding unrelated branches', () => {
    const filtered = filterTaskDag(dag, new Set(['in_progress']));

    expect(filtered.nodes.map(node => [node.id, node.matchesFilter])).toEqual([
      ['F1', true],
      ['B2', false],
      ['C3', false],
    ]);
    expect(filtered.edges).toEqual([
      { from: 'F1', to: 'B2' },
      { from: 'B2', to: 'C3' },
    ]);
    expect([filtered.matchCount, filtered.contextCount]).toEqual([1, 2]);
  });

  it('returns fresh nodes and edges in the explicit all state', () => {
    const all = filterTaskDag(dag, null);

    expect(all.nodes).not.toBe(dag.nodes);
    expect(all.edges).not.toBe(dag.edges);
    expect(all.nodes.every(node => node.matchesFilter)).toBe(true);
  });
});

describe('layoutTaskDag', () => {
  it('places dependencies above their dependents and draws arrows downward', () => {
    const layout = layoutTaskDag(
      filterTaskDag(taskDag([taskSummary({ id: 'F1', dependsOn: ['B2'] }), taskSummary({ id: 'B2' })]), null),
    );
    const dependent = layout.nodes.find(node => node.id === 'F1');
    const dependency = layout.nodes.find(node => node.id === 'B2');

    expect(dependency?.depth).toBeLessThan(dependent?.depth as number);
    expect(layout.edges[0]).toMatchObject({ dependentId: 'F1', dependencyId: 'B2' });
    expect(layout.edges[0]?.path).toContain('C');
  });

  it('gives a one-character preview a visible leading character', () => {
    expect(taskTitlePreview('abcdef', 1)).toBe('a…');
  });

  it('keeps a malformed cycle renderable rather than recursing forever', () => {
    const layout = layoutTaskDag(
      filterTaskDag(
        taskDag([
          taskSummary({ id: 'F1', dependsOn: ['B2'] }),
          taskSummary({ id: 'B2', kind: 'bug', dependsOn: ['F1'] }),
        ]),
        null,
      ),
    );

    expect(layout.nodes).toHaveLength(2);
  });
});
