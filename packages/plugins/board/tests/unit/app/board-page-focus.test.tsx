/**
 * W-89: a board narrowed to one project keeps the way back to every project, even when no task is left in it.
 * The REAL `BoardPage` over a scripted daemon port.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { DaemonBoardStore } from '../../../app/lib/board-store.ts';
import { THIS_MACHINE } from '../../../app/lib/machine.ts';
import { BoardPage } from '../../../app/views/board-page.tsx';
import { boardAnswer, boardTask, fakeEnvironment, fakePort, laneSetFor, PROJECT } from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const projects = [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() }] as never;

const draw = async (tasks: ReturnType<typeof boardTask>[], searches: string[]): Promise<HTMLElement> => {
  const store = new DaemonBoardStore(
    fakePort({
      board: async () => boardAnswer(tasks, { laneSet: null, projectId: null }),
      projects: async () => projects,
    }),
    fakeEnvironment(),
  );
  view = await mount(
    <BoardPage
      callsigns={new Map()}
      machines={[{ connection: THIS_MACHINE, name: 'This machine' }]}
      now={NOW}
      onNavigate={() => undefined}
      onSearch={search => searches.push(search)}
      search={`project=${PROJECT}`}
      store={store}
    />,
  );
  const root = view.container;
  await settleUntil(
    () => root.querySelector('[data-project-focus="all"], .fy-board__empty') !== null,
    () => `the board to draw; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

describe('W-89 a focused project keeps its way back', () => {
  it('names the project with "All projects" when its last visible task has left', async () => {
    const searches: string[] = [];
    const root = await draw([], searches);
    expect(root.querySelector('.fy-board-project__name')?.textContent).toBe('ferretry');
    expect(root.querySelector('.fy-board-project__count')?.textContent).toBe('0 tasks');
    expect(root.textContent).not.toContain('No project has a board yet');
    await interact(() => must(root.querySelector<HTMLElement>('[data-project-focus="all"]'), 'All projects').click());
    expect(searches.at(-1)).not.toContain('project=');
  });

  it('keeps showing the project and its way back while it still has tasks', async () => {
    const root = await draw([boardTask('F1', { laneId: 'todo', title: 'One' })], []);
    expect(root.querySelector('[data-project-focus="all"]')).not.toBeNull();
  });
});
