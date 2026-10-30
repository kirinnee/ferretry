import { afterEach, describe, expect, it } from 'bun:test';
import { boardErr, boardOk } from '@ferretry/protocol';
import { BoardPage, type BoardPageProps } from '../../../src/features/board/board-page.tsx';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import {
  boardAnswer,
  COUNTS,
  card,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  PROJECT,
  workstation,
} from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const LEAD = 'mvuc7tsf-0c3d50df';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const OPEN = [
  card('F1', { title: 'Plan the thing', laneId: 'plan', owner: LEAD }),
  card('F2', { title: 'Build the thing', laneId: 'implement', owner: LEAD, activity: 'stale' }),
  card('F3', { title: 'Review the thing', laneId: 'review' }),
  card('F4', { title: 'Try the thing', laneId: 'tested', activity: 'idle' }),
];
const CLOSED = [card('F8', { title: 'Old closed thing', laneId: 'closed', lastTouchedAt: '2026-07-01T00:00:00.000Z' })];
const DROPPED = [card('F9', { title: 'Dropped idea', laneId: 'todo', lastTouchedAt: '2026-07-02T00:00:00.000Z' })];

interface Harness {
  readonly acts: { daemonId: string; id: string; request: unknown }[];
  readonly navigated: string[];
  readonly searches: string[];
  readonly reads: string[];
  /** The ferret each board read asked the daemon for (the daemon does the filtering). */
  readonly asked: (string | null)[];
  readonly root: HTMLElement;
}

const open = async (
  extra: {
    props?: Partial<BoardPageProps>;
    act?: (request: unknown) => ReturnType<DaemonBoardStore['act']>;
    machines?: BoardPageProps['machines'];
    open?: typeof OPEN;
    fail?: boolean;
  } = {},
): Promise<Harness> => {
  const acts: Harness['acts'] = [];
  const navigated: string[] = [];
  const searches: string[] = [];
  const reads: string[] = [];
  const asked: (string | null)[] = [];
  const port = fakePort({
    board: async (daemon, query) => {
      reads.push(`${daemon.daemonId}:${query.state}`);
      asked.push(query.ferret);
      if (extra.fail === true) throw new Error('down');
      const cards = query.state === 'closed' ? CLOSED : query.state === 'dropped' ? DROPPED : (extra.open ?? OPEN);
      return boardAnswer(cards, {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: { ...COUNTS, toTest: 1, closedHidden: 1 },
      });
    },
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  store.act = async (daemon, id, request) => {
    acts.push({ daemonId: daemon.daemonId, id, request });
    return extra.act === undefined ? boardOk(card(id)) : extra.act(request);
  };
  const props: BoardPageProps = {
    store,
    agenda: { respond: async () => undefined },
    machines: extra.machines ?? [{ connection: laptop, name: 'laptop' }],
    callsigns: new Map([[LEAD, 'denisha']]),
    search: '',
    onSearch: search => void searches.push(search),
    onNavigate: to => void navigated.push(to),
    now: NOW,
    ...extra.props,
  };
  view = await mount(<BoardPage {...props} />);
  await interact(() => flush());
  return { acts, navigated, searches, reads, asked, root: view.container };
};

const click = (root: HTMLElement, selector: string) =>
  interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
const titles = (root: HTMLElement) => [...root.querySelectorAll('.fy-board-card__title')].map(node => node.textContent);
/** The advanced filters start folded behind "Filters"; this opens them. */
const unfold = (root: HTMLElement) => click(root, '.fy-board-filters__toggle');
const typeInto = async (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};

const openMenu = async (root: HTMLElement, task: string) => {
  const li = must(root.querySelector(`.fy-board-card[data-task="${task}"]`), `card ${task}`);
  await interact(() => must(li.querySelector<HTMLButtonElement>('.fy-board-card__more'), 'the menu').click());
  return li;
};
const pickLane = (li: Element, name: string) =>
  interact(() =>
    must(
      [...li.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === name),
      name,
    ).click(),
  );

describe('BoardPage — reading', () => {
  it('draws the lanes of the project with every open card, the counts and no closed lane', async () => {
    const { root, reads } = await open();
    expect(root.querySelector('h1')?.textContent).toBe('Board');
    expect(titles(root)).toEqual(['Plan the thing', 'Build the thing', 'Review the thing', 'Try the thing']);
    expect(root.querySelector('[data-count="to_test"]')?.textContent).toBe('To test1');
    expect(root.querySelector('[data-count="closed"]')?.textContent).toBe('1 closed hidden');
    expect([...root.querySelectorAll('.fy-board-lane__name')].map(node => node.textContent)).not.toContain('Closed');
    expect(root.querySelector('.fy-board__reading')).toBeNull();
    expect(reads).toEqual(['daemon/laptop:open']);
  });

  it('names the ferret by callsign on the card', async () => {
    const { root } = await open();
    expect(root.querySelector('[data-task="F1"] [data-seg="people"]')?.textContent).toBe('Denisha');
  });

  it('links a card to /d/:id/board/:taskId and navigates in the app', async () => {
    const { root, navigated } = await open();
    const link = must(root.querySelector<HTMLAnchorElement>('[data-task="F1"] a'), 'the link');
    expect(link.getAttribute('href')).toBe(`/d/${encodeURIComponent('daemon/laptop')}/board/F1`);
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual([link.getAttribute('href') ?? '']);
  });

  it('says it is reading while nothing has answered, and when no project has a board', async () => {
    const held = new DaemonBoardStore(fakePort({ board: () => new Promise(() => undefined) }), fakeEnvironment());
    view = await mount(
      <BoardPage
        agenda={{ respond: async () => undefined }}
        callsigns={new Map()}
        machines={[{ connection: laptop, name: 'laptop' }]}
        now={NOW}
        onNavigate={() => undefined}
        onSearch={() => undefined}
        search=""
        store={held}
      />,
    );
    expect(view.container.querySelector('.fy-board__reading')?.textContent).toBe('Reading the board…');
    await view.unmount();
    view = null;
    const empty = await open({ open: [] });
    expect(empty.root.querySelector('.fy-board__empty')?.textContent).toBe('No project has a board yet.');
  });

  it('says so, with a retry, when every machine failed', async () => {
    const { root, reads } = await open({ fail: true });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('The board could not be read.');
    const before = reads.length;
    await click(root, '.fy-board__retry');
    await interact(() => flush());
    expect(reads.length).toBeGreaterThan(before);
  });

  it('says which machine did not answer and still shows the others', async () => {
    const port = fakePort({
      board: async daemon => {
        if (daemon.daemonId === workstation.daemonId) throw new Error('offline');
        return boardAnswer(OPEN, { projectId: PROJECT, laneSet: laneSetFor() });
      },
    });
    const store = new DaemonBoardStore(port, fakeEnvironment());
    view = await mount(
      <BoardPage
        agenda={{ respond: async () => undefined }}
        callsigns={new Map()}
        machines={[
          { connection: laptop, name: 'laptop' },
          { connection: workstation, name: 'workstation' },
        ]}
        now={NOW}
        onNavigate={() => undefined}
        onSearch={() => undefined}
        search=""
        store={store}
      />,
    );
    await interact(() => flush());
    expect(view.container.querySelector('[data-machine="daemon/workstation"]')?.textContent).toBe(
      'workstation did not answer: offline',
    );
    expect(titles(view.container)).toHaveLength(4);
    expect(view.container.querySelector('[data-seg="machine"]')?.textContent).toBe('laptop');
  });
});

describe('BoardPage — views', () => {
  it('moves between views through the URL, keeping Kanban as the bare address', async () => {
    const { root, searches } = await open();
    expect(root.querySelector('[data-view-tab="kanban"]')?.getAttribute('aria-current')).toBe('page');
    await click(root, '[data-view-tab="list"]');
    await click(root, '[data-view-tab="archive"]');
    expect(searches).toEqual(['view=list', 'view=archive']);
  });

  it('returns to Kanban by dropping the view from the URL', async () => {
    const { root, searches } = await open({ props: { search: 'view=list' } });
    await click(root, '[data-view-tab="kanban"]');
    expect(searches).toEqual(['']);
  });

  it('draws the List sorted, and keeps the sort in the URL', async () => {
    const { root, searches } = await open({ props: { search: 'view=list' } });
    expect(titles(root)[0]).toBe('Build the thing');
    await click(root, '[data-sort="lane"]');
    await click(root, '[data-sort="stale"]');
    expect(searches).toEqual(['view=list&sort=lane', 'view=list']);
  });

  it('draws the Tree and the Dependencies views', async () => {
    const tree = await open({
      props: { search: 'view=tree' },
      open: [card('F10', { title: 'Lead' }), card('F11', { title: 'Child', parent: { id: 'F10' } })],
    });
    expect(tree.root.querySelector('[data-task="F11"]')?.getAttribute('data-depth')).toBe('1');
    await view?.unmount();
    view = null;
    const deps = await open({ props: { search: 'view=dependencies' } });
    expect(deps.root.querySelector('.fy-board-empty')?.textContent).toBe('No card depends on another.');
  });

  it('opens the Archive from "closed hidden" and lists closed and dropped work, newest first', async () => {
    const { root, searches, reads } = await open({ props: { search: 'view=archive' } });
    expect(titles(root)).toEqual(['Dropped idea', 'Old closed thing']);
    expect(reads).toContain('daemon/laptop:closed');
    expect(reads).toContain('daemon/laptop:dropped');
    expect(root.querySelector('.fy-board-card[draggable="true"]')).toBeNull();
    await interact(() => flush());
    expect(searches).toEqual([]);
  });

  it('opens the Archive from the counts header', async () => {
    const { root, searches } = await open();
    await click(root, '[data-count="closed"]');
    expect(searches).toEqual(['view=archive']);
  });

  it('searches the archive and pages through it', async () => {
    const { root } = await open({ props: { search: 'view=archive' } });
    await typeInto(
      must(root.querySelector<HTMLInputElement>('input[aria-label="Search the archive"]'), 'search'),
      'dropped',
    );
    expect(titles(root)).toEqual(['Dropped idea']);
    await typeInto(must(root.querySelector<HTMLInputElement>('input[aria-label="Search the archive"]'), 'search'), '');
    expect(root.querySelector('.fy-board-archive__more')).toBeNull();
  });

  it('reads only the kind of closed work the State filter names', async () => {
    const closedOnly = await open({ props: { search: 'view=archive&state=closed' } });
    expect(titles(closedOnly.root)).toEqual(['Old closed thing']);
    expect(closedOnly.reads.some(read => read.endsWith(':dropped'))).toBe(false);
    await view?.unmount();
    view = null;
    const droppedOnly = await open({ props: { search: 'view=archive&state=dropped' } });
    expect(titles(droppedOnly.root)).toEqual(['Dropped idea']);
    expect(droppedOnly.reads.some(read => read.endsWith(':closed'))).toBe(false);
  });
});

describe('BoardPage — filters and counts', () => {
  it('reads the filters from the URL and writes a change back, keeping the view', async () => {
    const { root, searches } = await open({ props: { search: 'view=list&kind=bug' } });
    await unfold(root);
    expect(root.querySelector<HTMLSelectElement>('[data-filter="kind"]')?.value).toBe('bug');
    expect(root.querySelector('.fy-board-filters__n')?.textContent).toBe('1');
    const select = must(root.querySelector<HTMLSelectElement>('[data-filter="activity"]'), 'activity');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'stale');
    await interact(() => select.dispatchEvent(new Event('change', { bubbles: true })));
    const written = new URLSearchParams(searches[0]);
    expect(written.get('view')).toBe('list');
    expect(written.get('kind')).toBe('bug');
    expect(written.get('activity')).toBe('stale');
  });

  it('turns the To test pill into the activity filter', async () => {
    const { root, searches } = await open();
    await click(root, '[data-count="to_test"]');
    expect(new URLSearchParams(searches[0]).get('activity')).toBe('to_test');
  });

  it('starts the filters folded on a narrow screen', async () => {
    const { root } = await open({ props: { phone: true } });
    expect(root.querySelector('.fy-board-filters__row')).toBeNull();
  });

  it('offers the ferrets and lanes of the board as choices', async () => {
    const { root } = await open();
    await unfold(root);
    expect(
      [...root.querySelectorAll('[data-filter="ferret"] option')].map(option => option.textContent).slice(0, 2),
    ).toEqual(['All ferrets', 'Denisha']);
    expect([...root.querySelectorAll('[data-filter="project"] option')].map(option => option.textContent)).toEqual([
      'All projects',
      'ferretry',
    ]);
    expect([...root.querySelectorAll('[data-filter="lane"] option')].map(option => option.textContent)).toContain(
      'Review/CI',
    );
  });
});

describe('BoardPage — opening from a chat', () => {
  const FROM = { daemonId: laptop.daemonId, sessionId: LEAD };

  it('keeps the advanced filters folded until Filters is pressed', async () => {
    const { root } = await open();
    expect(root.querySelector('.fy-board-filters__row')).toBeNull();
    await unfold(root);
    expect(root.querySelector('.fy-board-filters__row')).not.toBeNull();
  });

  it('shows no scope toggle when the reader did not come from a chat', async () => {
    const { root } = await open();
    expect(root.querySelector('[data-board-scope]')).toBeNull();
    expect(titles(root)).toContain('Review the thing');
  });

  it('opens on the chat ferret’s cards, with a one-tap All cards', async () => {
    const { root, asked } = await open({ props: { origin: FROM } });
    expect(root.querySelector('[data-board-scope]')?.getAttribute('data-board-scope')).toBe('ferret');
    expect(root.querySelector('[data-scope="ferret"]')?.textContent).toBe('Denisha');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(ferret => ferret === LEAD)).toBe(true);
    // The ferret scope is the page's own default, not an advanced filter to count.
    expect(root.querySelector('.fy-board-filters__n')).toBeNull();
  });

  it('writes cards=all when All cards is pressed, and drops the ferret', async () => {
    const { root, searches } = await open({ props: { origin: FROM, search: 'view=list' } });
    await click(root, '[data-scope="all"]');
    const written = new URLSearchParams(searches[0]);
    expect(written.get('cards')).toBe('all');
    expect(written.get('ferret')).toBeNull();
    expect(written.get('view')).toBe('list');
  });

  it('shows every card once the URL asks for them, and can narrow back', async () => {
    const { root, searches, asked } = await open({ props: { origin: FROM, search: 'cards=all' } });
    expect(root.querySelector('[data-board-scope]')?.getAttribute('data-board-scope')).toBe('all');
    expect(asked.every(ferret => ferret === null)).toBe(true);
    await click(root, '[data-scope="ferret"]');
    const written = new URLSearchParams(searches[0]);
    expect(written.get('ferret')).toBe(LEAD);
    expect(written.get('cards')).toBeNull();
  });

  it('lets a ferret named in the URL win over the chat', async () => {
    const { root } = await open({ props: { origin: FROM, search: 'ferret=someone-else' } });
    expect(root.querySelector('[data-board-scope]')?.getAttribute('data-board-scope')).toBe('all');
    expect(root.querySelector('.fy-board-filters__n')?.textContent).toBe('1');
  });
});

describe('BoardPage — moving cards', () => {
  it('sends a forward move from the menu without a reason', async () => {
    const { root, acts } = await open();
    const li = await openMenu(root, 'F2');
    await pickLane(li, 'Review/CI');
    expect(acts).toEqual([{ daemonId: 'daemon/laptop', id: 'F2', request: { action: 'move', to: 'review' } }]);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('asks for a one-line reason before a move back, and sends nothing until it has one', async () => {
    const { root, acts } = await open();
    const li = await openMenu(root, 'F3');
    await pickLane(li, 'Implement');
    expect(acts).toEqual([]);
    const dialog = must(root.querySelector('[role="dialog"]'), 'the reason box');
    expect(dialog.textContent).toContain('Move Review the thing back to Implement');
    const submit = must(dialog.querySelector<HTMLButtonElement>('button[type="submit"]'), 'submit');
    expect(submit.disabled).toBe(true);
    await typeInto(
      must(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'), 'reason'),
      'CI is red again',
    );
    await interact(() => dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(acts).toEqual([
      { daemonId: 'daemon/laptop', id: 'F3', request: { action: 'move', to: 'implement', reason: 'CI is red again' } },
    ]);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('drops the move when the reason box is cancelled', async () => {
    const { root, acts } = await open();
    await pickLane(await openMenu(root, 'F3'), 'Todo');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-board-reason button[type="button"]'), 'Cancel').click(),
    );
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(acts).toEqual([]);
  });

  it('keeps the reason box open and shows the refusal when the daemon says no', async () => {
    const { root, acts } = await open({
      act: async () => boardErr({ status: 409, message: 'That lane is gated.', boardCode: 'owner-gate' as const }),
    });
    await pickLane(await openMenu(root, 'F3'), 'Todo');
    const dialog = must(root.querySelector('[role="dialog"]'), 'the reason box');
    await typeInto(must(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'), 'reason'), 'because');
    await interact(() => dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(acts).toHaveLength(1);
    expect(root.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('That lane is gated.');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-board-reason button[type="button"]'), 'Cancel').click(),
    );
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says so when a forward move does not go through, and the notice can be dismissed', async () => {
    const { root } = await open({
      act: async () => boardErr({ status: 500, message: 'boom', boardCode: 'owner-gate' as const }),
    });
    await pickLane(await openMenu(root, 'F2'), 'Review/CI');
    expect(root.querySelector('.fy-board__notice')?.textContent).toContain('The move did not go through.');
    await click(root, '.fy-board__notice-x');
    expect(root.querySelector('.fy-board__notice')).toBeNull();
  });

  it('closes a card from To test in one tap with "Works → Close"', async () => {
    const { root, acts } = await open();
    await click(root, '[data-task="F4"] [data-verdict="works"]');
    expect(acts).toEqual([{ daemonId: 'daemon/laptop', id: 'F4', request: { action: 'move', to: 'closed' } }]);
  });

  it('sends "Not good" back to the last active lane, with a reason', async () => {
    const { root, acts } = await open();
    await click(root, '[data-task="F4"] [data-verdict="not-good"]');
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('Move Try the thing back to Implement');
    expect(acts).toEqual([]);
  });

  it('does not move a card in the Archive', async () => {
    const { root } = await open({ props: { search: 'view=archive' } });
    expect(root.querySelector('.fy-board-card__more')).toBeNull();
  });

  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { effectAllowed: '', dropEffect: '', setData: () => undefined },
    });
    return event;
  };
  const laneNamed = (root: HTMLElement, name: string) =>
    must(
      [...root.querySelectorAll<HTMLElement>('.fy-board-lane')].find(lane =>
        lane.getAttribute('aria-label')?.startsWith(name),
      ),
      name,
    );

  it('moves a card forward when it is dropped on a later lane', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector('[data-task="F2"]'), 'F2').dispatchEvent(drag('dragstart')));
    expect(root.querySelector('[data-task="F2"]')?.hasAttribute('data-dragging')).toBe(true);
    await interact(() => laneNamed(root, 'Review').dispatchEvent(drag('drop')));
    expect(acts).toEqual([{ daemonId: 'daemon/laptop', id: 'F2', request: { action: 'move', to: 'review' } }]);
    expect(root.querySelector('[data-dragging]')).toBeNull();
  });

  it('asks for a reason when a card is dragged back', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector('[data-task="F3"]'), 'F3').dispatchEvent(drag('dragstart')));
    await interact(() => laneNamed(root, 'Plan').dispatchEvent(drag('drop')));
    expect(acts).toEqual([]);
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('Move Review the thing back to Plan/Design');
  });

  it('closes a card dropped on the "Works → Close" target', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector('[data-task="F4"]'), 'F4').dispatchEvent(drag('dragstart')));
    await interact(() => must(root.querySelector('[data-variant="target"]'), 'the target').dispatchEvent(drag('drop')));
    expect(acts).toEqual([{ daemonId: 'daemon/laptop', id: 'F4', request: { action: 'move', to: 'closed' } }]);
  });

  it('ignores a drop on the lane the card is already in, and a drag that ends elsewhere', async () => {
    const { root, acts } = await open();
    await interact(() => must(root.querySelector('[data-task="F2"]'), 'F2').dispatchEvent(drag('dragstart')));
    await interact(() => laneNamed(root, 'Implement').dispatchEvent(drag('drop')));
    await interact(() => must(root.querySelector('[data-task="F2"]'), 'F2').dispatchEvent(drag('dragstart')));
    await interact(() => must(root.querySelector('[data-task="F2"]'), 'F2').dispatchEvent(drag('dragend')));
    expect(root.querySelector('[data-dragging]')).toBeNull();
    expect(acts).toEqual([]);
  });
});

describe('BoardPage — odd boards', () => {
  const twoMachines = [
    { connection: laptop, name: 'laptop' },
    { connection: workstation, name: 'workstation' },
  ];

  it("heads each machine's board and falls back to a short id when the project has no name", async () => {
    const port = fakePort({
      board: async () => boardAnswer(OPEN, { projectId: PROJECT, laneSet: laneSetFor() }),
      projects: async () => [],
    });
    view = await mount(
      <BoardPage
        agenda={{ respond: async () => undefined }}
        callsigns={new Map()}
        machines={twoMachines}
        now={NOW}
        onNavigate={() => undefined}
        onSearch={() => undefined}
        search=""
        store={new DaemonBoardStore(port, fakeEnvironment())}
      />,
    );
    await interact(() => flush());
    const heads = [...view.container.querySelectorAll('.fy-board-project__head')].map(node => node.textContent);
    expect(heads).toEqual([`${PROJECT.slice(0, 8)}laptopLanes ✎`, `${PROJECT.slice(0, 8)}workstationLanes ✎`]);
  });

  it('refuses a move for a card sitting in a lane the project does not have', async () => {
    const { root, acts } = await open({ open: [card('F7', { title: 'Lost card', laneId: 'nowhere' })] });
    const li = await openMenu(root, 'F7');
    await pickLane(li, 'Review/CI');
    expect(acts).toEqual([]);
    expect(root.querySelector('.fy-board__notice')?.textContent).toContain('nowhere');
  });

  it('keeps its own clock when it is not handed one', async () => {
    const { root } = await open({ props: { now: undefined } });
    expect(titles(root)).toHaveLength(4);
  });
});

describe('BoardPage — lane editor entry', () => {
  it('puts a Lanes ✎ link in the header that opens the lane editor of the one project', async () => {
    const { root, navigated } = await open();
    expect(root.querySelector('.fy-board-project__lanes')).toBeNull();
    await click(root, '[data-board-lanes="header"]');
    expect(navigated).toEqual([`/d/${encodeURIComponent('daemon/laptop')}/projects/${PROJECT}/lanes`]);
  });

  it('heads each project with its own Lanes ✎ link when several boards are drawn', async () => {
    const { root, navigated } = await open({
      machines: [
        { connection: laptop, name: 'laptop' },
        { connection: workstation, name: 'workstation' },
      ],
    });
    expect(root.querySelector('[data-board-lanes="header"]')).toBeNull();
    const links = [...root.querySelectorAll<HTMLElement>('.fy-board-project__lanes')];
    expect(links).toHaveLength(2);
    await interact(() => must(links[1], 'the second link').click());
    expect(navigated).toEqual([`/d/${encodeURIComponent('daemon/workstation')}/projects/${PROJECT}/lanes`]);
  });

  it('has no entry while no project has a board', async () => {
    const { root } = await open({ open: [] });
    expect(root.querySelector('[data-board-lanes]')).toBeNull();
  });
});
