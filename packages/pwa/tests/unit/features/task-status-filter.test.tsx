import { describe, expect, it } from 'bun:test';
import type { TaskStatus } from '@ferretry/protocol';
import { TaskStatusFilter } from '../../../src/features/tasks/task-status-filter.tsx';
import { interact, mount } from '../../support/dom.ts';

const counts = new Map<TaskStatus, number>([
  ['done', 2],
  ['todo', 1],
  ['blocked', 1],
]);

interface Mounted {
  readonly container: HTMLElement;
  readonly selected: TaskStatus[];
  readonly showAll: number;
}

const chips = (container: HTMLElement): HTMLButtonElement[] => [...container.querySelectorAll('button')];
const labelled = (container: HTMLElement, prefix: string): HTMLButtonElement => {
  const chip = chips(container).find(button => (button.getAttribute('aria-label') ?? '').startsWith(prefix));
  if (chip === undefined) throw new Error(`no chip labelled ${prefix}`);
  return chip;
};

const open = async (selected: ReadonlySet<TaskStatus> | null): Promise<Mounted> => {
  const state = { selected: [] as TaskStatus[], showAll: 0 };
  const { container } = await mount(
    <TaskStatusFilter
      counts={counts}
      selected={selected}
      onSelect={status => state.selected.push(status)}
      onShowAll={() => {
        state.showAll += 1;
      }}
    />,
  );
  return {
    container,
    get selected() {
      return state.selected;
    },
    get showAll() {
      return state.showAll;
    },
  };
};

describe('TaskStatusFilter', () => {
  it('renders All plus one chip per present status, in board order', async () => {
    const { container } = await open(null);

    expect(chips(container).map(chip => chip.textContent)).toEqual(['All 4', 'To do 1', 'Done 2', 'Blocked 1']);
  });

  it('totals every count on the All chip', async () => {
    const { container } = await open(null);

    expect(chips(container)[0]?.textContent).toBe('All 4');
  });

  it('presses All only while the filter is in the explicit All state', async () => {
    const allOff = await open(new Set<TaskStatus>(['done']));
    const allOn = await open(null);

    expect(chips(allOff.container)[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(chips(allOn.container)[0]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('carries each chip status tone as state, never as a colour class', async () => {
    const { container } = await open(null);

    expect(labelled(container, 'Blocked').getAttribute('data-tone')).toBe('err');
    expect(labelled(container, 'Done').getAttribute('data-tone')).toBe('ok');
    expect(labelled(container, 'To do').className).toContain('kt-task-tone');
    expect(labelled(container, 'To do').className).not.toContain('bg-err');
  });

  it('lights a selected chip in its own status colour rather than a generic accent', async () => {
    const { container } = await open(new Set<TaskStatus>(['blocked']));

    expect(labelled(container, 'Blocked').className).toContain('kt-task-chip-active');
    expect(labelled(container, 'Done').className).toContain('border-border-soft');
    expect(labelled(container, 'Blocked').getAttribute('aria-pressed')).toBe('true');
  });

  it('announces the count in words and pluralises it', async () => {
    const { container } = await open(null);

    expect(labelled(container, 'Done').getAttribute('aria-label')).toBe('Done, 2 tasks');
    expect(labelled(container, 'To do').getAttribute('aria-label')).toBe('To do, 1 task');
  });

  it('flips the title between adding and removing the filter', async () => {
    const resting = await open(null);
    const active = await open(new Set<TaskStatus>(['done']));

    expect(labelled(resting.container, 'Done').getAttribute('title')).toBe('Show Done tasks');
    expect(labelled(active.container, 'Done').getAttribute('title')).toBe('Remove Done from the filter');
  });

  it('keeps a selected zero-count status mounted so it can be switched off again', async () => {
    const { container } = await open(new Set<TaskStatus>(['live']));

    expect(labelled(container, 'Live').getAttribute('aria-label')).toBe('Live, 0 tasks');
  });

  it('reports the pressed status and the All reset to its host', async () => {
    const view = await open(null);

    await interact(() => labelled(view.container, 'Blocked').click());
    await interact(() => chips(view.container)[0]?.click());

    expect(view.selected).toEqual(['blocked']);
    expect(view.showAll).toBe(1);
  });

  it('gives the group an accessible name and contains a horizontal swipe', async () => {
    const { container } = await open(null);
    const group = container.querySelector('fieldset');

    expect(group?.getAttribute('aria-label')).toBe('Filter tasks by status');
    expect(group?.className).toContain('overscroll-x-contain');
  });

  it('keeps every chip at the 44px touch floor', async () => {
    const { container } = await open(null);

    for (const chip of chips(container)) {
      expect(chip.className).toContain('min-h-[44px]');
      expect(chip.className).toContain('min-w-[44px]');
    }
  });
});
