import { afterEach, describe, expect, it } from 'bun:test';
import { BoardCountsBar } from '../../../src/features/board/board-counts.tsx';
import { type BoardFilterChoices, BoardFilterBar } from '../../../src/features/board/board-filters.tsx';
import { type BoardFilters, NO_BOARD_FILTERS } from '../../../src/lib/board-model.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { laptop, PROJECT, workstation } from '../board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const change = (node: Element, value: string) => {
  const select = node as HTMLSelectElement | HTMLInputElement;
  const proto = select instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event(select instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};

describe('BoardCountsBar', () => {
  const counts = { closedHidden: 7, stale: 2, orphaned: 1, active: 5, toTest: 3, waitingOnYou: 4 };

  it('shows the daemon’s numbers as pills, chips and "N closed hidden"', async () => {
    view = await mount(
      <BoardCountsBar activity={null} counts={counts} onActivity={() => undefined} onOpenArchive={() => undefined} />,
    );
    const root = view.container;
    expect(root.querySelector('[data-count="to_test"]')?.textContent).toBe('🧪 To test3');
    expect(root.querySelector('[data-count="waiting_on_you"]')?.textContent).toBe('🚧 Waiting on you4');
    expect(root.querySelector('[data-count="stale"]')?.getAttribute('aria-label')).toBe('2 stale');
    expect(root.querySelector('[data-count="closed"]')?.textContent).toBe('7 closed hidden');
  });

  it('turns a pill into a filter and lifts it when pressed again', async () => {
    const seen: (string | null)[] = [];
    view = await mount(
      <BoardCountsBar
        activity="to_test"
        counts={counts}
        onActivity={next => void seen.push(next)}
        onOpenArchive={() => undefined}
      />,
    );
    const toTest = must(view.container.querySelector<HTMLButtonElement>('[data-count="to_test"]'), 'To test');
    expect(toTest.getAttribute('aria-pressed')).toBe('true');
    await interact(() => toTest.click());
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-count="waiting_on_you"]'), 'Waiting').click(),
    );
    expect(seen).toEqual([null, 'waiting_on_you']);
  });

  it('marks an empty count and opens the Archive from "closed hidden"', async () => {
    let opened = 0;
    view = await mount(
      <BoardCountsBar
        activity={null}
        counts={{ ...counts, stale: 0 }}
        onActivity={() => undefined}
        onOpenArchive={() => {
          opened += 1;
        }}
      />,
    );
    expect(view.container.querySelector('[data-count="stale"]')?.hasAttribute('data-empty')).toBe(true);
    expect(view.container.querySelector('[data-count="active"]')?.hasAttribute('data-empty')).toBe(false);
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-count="closed"]'), 'closed').click(),
    );
    expect(opened).toBe(1);
  });
});

describe('BoardFilterBar', () => {
  const choices: BoardFilterChoices = {
    projects: [{ id: PROJECT, name: 'ferretry' }],
    machines: [
      { daemonId: laptop.daemonId, name: 'laptop' },
      { daemonId: workstation.daemonId, name: 'workstation' },
    ],
    ferrets: [{ id: 'mvuc7tsf-0c3d50df', name: 'Denisha' }],
    lanes: ['Todo', 'Implement'],
  };

  const bar = (
    filters: BoardFilters,
    onChange: (next: BoardFilters) => void,
    extra: Partial<Parameters<typeof BoardFilterBar>[0]> = {},
  ) => <BoardFilterBar choices={choices} filters={filters} onChange={onChange} {...extra} />;

  const drawn = async (
    filters: BoardFilters = NO_BOARD_FILTERS,
    extra: Partial<Parameters<typeof BoardFilterBar>[0]> = {},
  ) => {
    const seen: BoardFilters[] = [];
    view = await mount(bar(filters, next => void seen.push(next), extra));
    return { root: view.container, seen };
  };

  const pick = async (root: HTMLElement, filter: string, value: string) => {
    await interact(() => change(must(root.querySelector(`[data-filter="${filter}"]`), `the ${filter} filter`), value));
  };

  it('offers every filter', async () => {
    const { root } = await drawn();
    const names = [...root.querySelectorAll('[data-filter]')].map(node => node.getAttribute('data-filter'));
    expect(names).toEqual([
      'project',
      'machine',
      'ferret',
      'kind',
      'pr',
      'activity',
      'state',
      'lane',
      'mine',
      'created',
      'created-preset',
      'touched',
      'touched-preset',
    ]);
  });

  it('writes each choice to the filter set', async () => {
    const { root, seen } = await drawn();
    await pick(root, 'project', PROJECT);
    await pick(root, 'machine', workstation.daemonId);
    await pick(root, 'ferret', 'mvuc7tsf-0c3d50df');
    await pick(root, 'kind', 'bug');
    await pick(root, 'pr', 'ci_red');
    await pick(root, 'activity', 'stale');
    await pick(root, 'state', 'closed');
    await pick(root, 'lane', 'Todo');
    expect(
      seen.map(
        next =>
          Object.entries(next).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify((NO_BOARD_FILTERS as never)[key]),
          )[0],
      ),
    ).toEqual([
      ['project', PROJECT],
      ['machine', workstation.daemonId],
      ['ferret', 'mvuc7tsf-0c3d50df'],
      ['kind', 'bug'],
      ['pr', 'ci_red'],
      ['activity', 'stale'],
      ['state', 'closed'],
      ['lane', 'Todo'],
    ]);
  });

  it('clears a choice back to "any" and ignores a value it does not know', async () => {
    const { root, seen } = await drawn({
      ...NO_BOARD_FILTERS,
      project: PROJECT,
      kind: 'bug',
      pr: 'open',
      activity: 'stale',
    });
    await pick(root, 'project', '');
    await pick(root, 'kind', '');
    await pick(root, 'pr', '');
    await pick(root, 'activity', '');
    expect(seen.map(next => [next.project, next.kind, next.pr, next.activity])).toEqual([
      [null, 'bug', 'open', 'stale'],
      [PROJECT, null, 'open', 'stale'],
      [PROJECT, 'bug', null, 'stale'],
      [PROJECT, 'bug', 'open', null],
    ]);
  });

  it('toggles Mine', async () => {
    const { root, seen } = await drawn();
    await interact(() => must(root.querySelector<HTMLInputElement>('[data-filter="mine"]'), 'Mine').click());
    expect(seen[0]?.mine).toBe(true);
  });

  it('hides the machine filter with a single machine', async () => {
    const { root } = await drawn(NO_BOARD_FILTERS, {
      choices: { ...choices, machines: [choices.machines[0] as never] },
    });
    expect(root.querySelector('[data-filter="machine"]')).toBeNull();
  });

  it('keeps an active lane choice the board no longer shows', async () => {
    const { root } = await drawn({ ...NO_BOARD_FILTERS, lane: 'Gone' });
    expect([...root.querySelectorAll('[data-filter="lane"] option')].map(option => option.textContent)).toEqual([
      'All lanes',
      'Todo',
      'Implement',
      'Gone',
    ]);
    await view?.unmount();
    view = null;
    const known = await drawn({ ...NO_BOARD_FILTERS, lane: 'Todo' });
    expect(known.root.querySelectorAll('[data-filter="lane"] option')).toHaveLength(3);
  });

  it('offers today, 7 days, 30 days and a custom range for created and touched', async () => {
    const { root, seen } = await drawn();
    expect(
      [...root.querySelectorAll('[data-filter="created-preset"] option')].map(option => option.textContent),
    ).toEqual(['Created: any', 'Created: today', 'Created: 7 days', 'Created: 30 days', 'Created: custom…']);
    await pick(root, 'created-preset', '7d');
    await pick(root, 'touched-preset', 'today');
    expect(seen[0]?.created).toEqual({ preset: '7d', from: null, to: null });
    expect(seen[1]?.touched).toEqual({ preset: 'today', from: null, to: null });
    await pick(root, 'created-preset', '');
    expect(seen[2]?.created).toEqual({ preset: null, from: null, to: null });
  });

  it('unfolds from and to dates for a custom range and writes them', async () => {
    const { root, seen } = await drawn();
    expect(root.querySelector('input[type="date"]')).toBeNull();
    await pick(root, 'created-preset', 'custom');
    expect(seen[0]?.created).toEqual({ preset: null, from: null, to: null });
    const from = must(root.querySelector('input[aria-label="Created from"]'), 'from');
    const to = must(root.querySelector('input[aria-label="Created to"]'), 'to');
    await interact(() => change(from, '2026-07-01'));
    await interact(() => change(to, '2026-07-31'));
    expect(seen[1]?.created).toEqual({ preset: null, from: '2026-07-01', to: null });
    expect(seen[2]?.created).toEqual({ preset: null, from: null, to: '2026-07-31' });
  });

  it('starts a custom range open when the URL already carries one, and links the two dates', async () => {
    const { root, seen } = await drawn({
      ...NO_BOARD_FILTERS,
      touched: { preset: null, from: '2026-07-01', to: '2026-07-31' },
    });
    expect(root.querySelector<HTMLSelectElement>('[data-filter="touched-preset"]')?.value).toBe('custom');
    expect(root.querySelector('input[aria-label="Touched from"]')?.getAttribute('max')).toBe('2026-07-31');
    expect(root.querySelector('input[aria-label="Touched to"]')?.getAttribute('min')).toBe('2026-07-01');
    await interact(() => change(must(root.querySelector('input[aria-label="Touched from"]'), 'from'), ''));
    await interact(() => change(must(root.querySelector('input[aria-label="Touched to"]'), 'to'), ''));
    expect(seen.map(next => [next.touched.from, next.touched.to])).toEqual([
      [null, '2026-07-31'],
      ['2026-07-01', null],
    ]);
  });

  it('counts what is set, clears it all and folds away', async () => {
    const { root, seen } = await drawn({ ...NO_BOARD_FILTERS, mine: true, kind: 'bug' });
    expect(root.querySelector('.fy-board-filters__n')?.textContent).toBe('2');
    await interact(() => must(root.querySelector<HTMLButtonElement>('.fy-board-filters__clear'), 'Clear').click());
    expect(seen[0]).toEqual(NO_BOARD_FILTERS);
    const toggle = must(root.querySelector<HTMLButtonElement>('.fy-board-filters__toggle'), 'Filters');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle.click());
    expect(root.querySelector('.fy-board-filters__row')).toBeNull();
    await interact(() => toggle.click());
    expect(root.querySelector('.fy-board-filters__row')).not.toBeNull();
  });

  it('has no count or Clear when nothing is set, and starts folded when asked', async () => {
    const { root } = await drawn(NO_BOARD_FILTERS, { defaultOpen: false });
    expect(root.querySelector('.fy-board-filters__n')).toBeNull();
    expect(root.querySelector('.fy-board-filters__clear')).toBeNull();
    expect(root.querySelector('.fy-board-filters__row')).toBeNull();
  });

  it('words the State choices for the Archive, which has no "all"', async () => {
    const { root } = await drawn(NO_BOARD_FILTERS, { archive: true });
    expect([...root.querySelectorAll('[data-filter="state"] option')].map(option => option.textContent)).toEqual([
      'Closed + dropped',
      'State: closed',
      'State: dropped',
    ]);
    await view?.unmount();
    view = null;
    const open = await drawn();
    expect([...open.root.querySelectorAll('[data-filter="state"] option')].map(option => option.textContent)).toEqual([
      'State: open',
      'State: closed',
      'State: dropped',
      'State: all',
    ]);
  });
});
