import { describe, expect, it } from 'bun:test';
import {
  TaskDagGraph,
  fitTaskDagTransform,
  shouldNavigateTaskAgentLink,
} from '../../../src/features/tasks/task-dag-graph.tsx';
import { filterTaskDag, taskDag } from '../../../src/features/tasks/task-dag.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, pressKey } from '../../support/dom.ts';
import { taskSummary } from '../../support/tasks.ts';

const alpha = daemonId('daemon-alpha');
const graph = filterTaskDag(
  taskDag([
    taskSummary({
      id: 'F1',
      title: 'Port the task graph',
      dependsOn: ['B2'],
      live: { assigneeSessionId: 'sess-9', assigneeName: 'Ada' },
    }),
    taskSummary({ id: 'B2', kind: 'bug', title: 'Preserve dependency context' }),
  ]),
  null,
);

describe('TaskDagGraph', () => {
  it('renders the graph and opens an accessible task node by mouse and keyboard', async () => {
    const opened: string[] = [];
    const { container } = await mount(
      <TaskDagGraph daemonId={alpha} dag={graph} onOpen={node => opened.push(node.id)} />,
    );
    const hit = container.querySelector('[data-task-node="F1"] [data-task-node-hit]') as SVGGElement;

    expect(container.querySelector('[data-task-edge="F1->B2"]')).not.toBeNull();
    expect(hit.getAttribute('aria-label')).toContain('&F1: Port the task graph');
    await interact(() => hit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await interact(() => pressKey(hit, 'Enter'));
    expect(opened).toEqual(['F1', 'F1']);
  });

  it('keeps an assignee link on the daemon that rendered the graph', async () => {
    const destinations: string[] = [];
    const { container } = await mount(
      <TaskDagGraph daemonId={alpha} dag={graph} onOpen={() => {}} onNavigate={to => destinations.push(to)} />,
    );
    const link = container.querySelector('[data-task-agent-link]') as SVGAElement;

    expect(link.getAttribute('href')).toBe('/d/daemon-alpha/session/sess-9');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
    expect(destinations).toEqual(['/d/daemon-alpha/session/sess-9']);
  });

  it('makes small mobile graphs touchable and preserves modifier-click browser behaviour', () => {
    expect(fitTaskDagTransform({ width: 400, height: 900 }, { width: 120, height: 200 }).scale).toBe(0.5);
    expect(
      shouldNavigateTaskAgentLink({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBe(true);
    expect(
      shouldNavigateTaskAgentLink({ button: 0, altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toBe(false);
  });

  it('states an empty filter and lets the host return to All', async () => {
    let shown = 0;
    const empty = filterTaskDag(graph, new Set(['done']));
    const { container } = await mount(
      <TaskDagGraph daemonId={alpha} dag={empty} onOpen={() => {}} onShowAll={() => (shown += 1)} />,
    );

    expect(container.textContent).toContain('No task nodes match this status filter.');
    const showAll = [...container.querySelectorAll('button')].find(button => button.textContent === 'Show all');
    await interact(() => showAll?.click());
    expect(shown).toBe(1);
  });

  it('handles resize, zoom, panning, pinch, missing paths, and modifier agent links', async () => {
    const previous = globalThis.ResizeObserver;
    let disconnected = 0;
    let observed = 0;
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        observed += 1;
        this.callback([], this as unknown as ResizeObserver);
      }
      disconnect(): void {
        disconnected += 1;
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
    const pointer = (type: string, pointerId: number, clientX: number, clientY: number): PointerEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        clientX: { value: clientX },
        clientY: { value: clientY },
      });
      return event;
    };
    const covered = filterTaskDag(
      taskDag(
        [
          taskSummary({
            id: 'F1',
            dependsOn: ['B2'],
            sessionId: 'session-a',
            live: { assigneeSessionId: 'sess-9', assigneeName: 'Ada' },
          } as never),
          taskSummary({ id: 'B2', kind: 'bug', sessionId: 'session-b' } as never),
          taskSummary({ id: 'F3', dependsOn: ['C9'] }),
        ],
        'session-a',
      ),
      new Set(['todo']),
    );
    const opened: string[] = [];
    const view = await mount(<TaskDagGraph daemonId={alpha} dag={covered} onOpen={node => opened.push(node.id)} />);
    try {
      const canvas = view.container.querySelector('.kt-task-dag-canvas') as HTMLElement;
      const agent = view.container.querySelector('[data-task-agent-link]') as SVGAElement;
      const missing = view.container.querySelector('[data-task-missing="true"] [data-task-node-hit]');

      await interact(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -30 })));
      await interact(() => canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointermove', 1, 20, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointerdown', 2, 40, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointermove', 1, 15, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointermove', 1, 10, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointerup', 2, 40, 10)));
      await interact(() => canvas.dispatchEvent(pointer('pointercancel', 1, 15, 10)));
      await interact(() => agent.dispatchEvent(pointer('pointerdown', 9, 0, 0)));
      await interact(() => agent.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 1 })));

      expect(missing).not.toBeNull();
      expect(view.container.textContent).toContain('OTHER');
      expect(opened).toEqual([]);
      expect(observed).toBeGreaterThan(0);
    } finally {
      await view.unmount();
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: previous });
    }
    expect(disconnected).toBe(1);
  });
});
