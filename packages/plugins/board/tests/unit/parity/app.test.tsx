/**
 * Board's app half, parity with today's Board surfaces (docs/design/rebuild-parity.tsv, owner `board`, kind S).
 *
 * Each surface is proved by drawing it: the half the shell builds is mounted (screens, panels, the settings tab and
 * both renderers, every one lazy behind a Suspense boundary as the shell mounts it) over a scripted daemon client, and
 * the test reads what it drew. The views' own behaviour is in the ported rendering suites under `tests/unit/app/`,
 * whose test names carry the same row ids.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PanelProps, PluginClient, RendererProps, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import manifest from '../../../manifest.ts';
import app from '../../../app/index.ts';
import { NO_BOARD_FILTERS, boardFiltersToSearch, parseBoardFilters } from '../../../app/lib/board-model.ts';
import { parseWorkName } from '../../../app/lib/card-name.ts';
import { boardCardPath, boardPath, cardPagePath, projectLanesPath } from '../../../app/lib/paths.ts';
import { BoardFilterSheet } from '../../../app/views/board-filters.tsx';
import { CardName } from '../../../app/views/card-name.tsx';
import { boardAnswer, card, laneSetFor, PROJECT } from '../app/board-support.ts';

const LEAD = 'mvuc7tsf-0c3d50df';

const CARDS = [
  card('F1', { laneId: 'todo', title: 'Fix the scroller' }),
  card('F2', { laneId: 'implement', title: 'Draw the lanes', parent: { id: 'F1' }, dependsOn: [] }),
  card('F3', { laneId: 'review', title: 'Wait on the lanes', blockedBy: [{ id: 'F2' }] }),
];

/** A daemon that answers Board's reads from the cards above; a route it does not know fails like an old daemon. */
const daemon: PluginClient = {
  call: async (route: string, init?: { readonly params?: Readonly<Record<string, string>> }) => {
    switch (route) {
      case 'GET /v1/board':
        return boardAnswer(CARDS, { projectId: PROJECT, laneSet: laneSetFor() });
      case 'GET /v1/board/projects':
        return {
          projects: [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() }],
          current: null,
        };
      case 'GET /v1/board/ids':
        return { ids: CARDS.map(entry => entry.id) };
      case 'GET /v1/board/cards/:cardId': {
        const found = CARDS.find(entry => entry.id === init?.params?.cardId);
        if (found === undefined) throw Object.assign(new Error('no such card'), { status: 404 });
        return { card: found, laneSet: laneSetFor() };
      }
      case 'GET /v1/ferrets':
        return [{ id: LEAD, name: 'denisha' }];
      case 'GET /v1/health':
        return { version: '5.0.0' };
      default:
        throw new Error(`no route ${route}`);
    }
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const half = app.build?.({ manifest, client: daemon });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.history?.replaceState({}, '', '/');
});

/** Puts the address bar at `path`. `mount` registers the DOM on first use, so an address set first needs one. */
const at = async (path: string): Promise<void> => {
  if (typeof window === 'undefined') await (await mount(<i />)).unmount();
  window.history.replaceState({}, '', path);
};

/** Mounts one of the half's surfaces as the shell does (inside Suspense), and waits for `ready`. */
const draw = async <Props extends object>(
  component: unknown,
  props: Props,
  ready: (root: HTMLElement) => boolean,
  what: string,
): Promise<HTMLElement> => {
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(component as FunctionComponent<Props>, props),
  );
  view = await mount(element);
  const root = view.container;
  await settleUntil(
    () => ready(root),
    () => `${what}; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const screen = (id: 'board' | 'card', params: ScreenProps['params']) => ({ component: half?.screens[id], params });

const drawBoard = async (search = '', params: ScreenProps['params'] = {}): Promise<HTMLElement> => {
  await at(`/board${search}`);
  const { component } = screen('board', params);
  return await draw<ScreenProps>(
    component,
    { params },
    root => root.querySelector('[data-task="F1"]') !== null,
    'the board drew F1',
  );
};

describe('the app half the shell builds', () => {
  it('S-0341 PAGE_SLOTS Board: the board and one card are screens, and the board screen draws the board', async () => {
    expect(Object.keys(half?.screens ?? {}).sort()).toEqual(['board', 'card']);
    expect(manifest.ui?.screens?.find(entry => entry.id === 'board')?.path).toBe('/board/:project?');
    const root = await drawBoard();
    expect([...root.querySelectorAll('[data-task]')].map(node => node.getAttribute('data-task'))).toEqual([
      'F1',
      'F2',
      'F3',
    ]);
  });

  it('S-0129 LeanGroupPanel: a ferret’s cards are a panel beside the ferret, drawing that ferret’s cards', async () => {
    expect(Object.keys(half?.panels ?? {}).sort()).toEqual(['card-progress', 'cards-of-ferret']);
    expect(manifest.ui?.panels?.find(entry => entry.id === 'cards-of-ferret')).toMatchObject({ slot: 'ferret.side' });
    const root = await draw<PanelProps>(
      half?.panels['cards-of-ferret'],
      { subject: LEAD },
      node => node.querySelector('[data-task]') !== null,
      'the panel drew a card of the ferret',
    );
    expect(root.querySelector('[data-task="F1"]')).not.toBeNull();
  });

  it('S-0298 feature board: the settings tab says where the GitHub watch is configured', async () => {
    expect(Object.keys(half?.settings ?? {})).toEqual(['board']);
    const root = await draw<SettingsProps>(
      half?.settings.board,
      {},
      node => node.querySelector('[data-settings="board"]') !== null,
      'the Board settings tab',
    );
    expect(root.textContent).toContain('config/board.yaml');
  });

  it('S-0298 feature board: a &F12 reference links the card by its title, and the card ask names it with no button', async () => {
    expect(Object.keys(half?.renderers ?? {}).sort()).toEqual(['ask:card', 'reference:&']);
    const reference = await draw<RendererProps>(
      half?.renderers['reference:&'],
      { value: '&F1' },
      node => node.querySelector('a') !== null,
      'the reference link',
    );
    expect(reference.querySelector('a')?.getAttribute('href')).toBe(cardPagePath('F1'));
    expect(reference.querySelector('a')?.getAttribute('title')).toBe('Fix the scroller');
    await view?.unmount();

    const ask = await draw<RendererProps>(
      half?.renderers['ask:card'],
      { value: { card: 'F1' } },
      node => (node.textContent ?? '').includes('Fix the scroller'),
      'the card ask with its title',
    );
    expect(ask.querySelector('[data-ask-card="F1"] a')?.textContent).toBe('&F1');
    expect(ask.querySelector('button')).toBeNull();
  });

  it('S-0298 feature board: the card is read-only status, so its page draws no answer surface', async () => {
    const root = await draw<ScreenProps>(
      half?.screens.card,
      { params: { id: 'F1' } },
      node => (node.textContent ?? '').includes('Fix the scroller'),
      'the card page of F1',
    );
    expect(root.querySelector('textarea, form')).toBeNull();
    const buttons = [...root.querySelectorAll('button')].map(button => (button.textContent ?? '').trim());
    for (const answer of ['Done', 'Not good', 'Reopen', 'Approve', 'Answer', 'Send'])
      expect(buttons).not.toContain(answer);
  });
});

describe('the board page and its views', () => {
  it('S-0038 BoardPage: the board screen draws the page with its view tabs', async () => {
    const root = await drawBoard();
    expect(root.querySelector('h1')).not.toBeNull();
    expect(root.querySelectorAll('[data-view-tab]').length).toBeGreaterThan(0);
  });

  it('S-0124 KanbanView: the default view is lanes of cards', async () => {
    const root = await drawBoard();
    expect(root.querySelector('.fy-board-lane__name')?.textContent).toBe('Todo');
  });

  it('S-0266 TableView S-0263 SummaryRowView: ?view=list draws the summary rows', async () => {
    await at('/board?view=list');
    const root = await draw<ScreenProps>(
      half?.screens.board,
      { params: {} },
      node => node.querySelector('.fy-board-summary__row') !== null,
      'the summary rows',
    );
    expect(root.querySelector('.fy-board-summary__head')).not.toBeNull();
  });

  it('S-0273 TreeView: ?view=tree indents a child under its lead', async () => {
    const root = await drawBoard('?view=tree');
    expect(root.querySelector('[data-task="F2"]')?.getAttribute('data-depth')).toBe('1');
  });

  it('S-0088 DependenciesView: ?view=dependencies lists what waits on what', async () => {
    await at('/board?view=dependencies');
    const root = await draw<ScreenProps>(
      half?.screens.board,
      { params: {} },
      node => node.querySelector('[data-dep]') !== null,
      'the dependency lines',
    );
    expect(root.querySelector('[data-dep="blocked-by"]')?.textContent).toContain('&F2');
  });

  it('S-0032 ArchiveView: ?view=archive offers the archive search', async () => {
    await at('/board?view=archive');
    const root = await draw<ScreenProps>(
      half?.screens.board,
      { params: {} },
      node => node.querySelector('input[aria-label="Search the archive"]') !== null,
      'the archive search',
    );
    expect(root.querySelector('input[aria-label="Search the archive"]')).not.toBeNull();
  });

  it('S-0037 BoardFilterSheet: the Filters button opens the sheet of filter fields', async () => {
    view = await mount(
      <BoardFilterSheet
        choices={{ projects: [], machines: [], ferrets: [], lanes: ['Todo'] }}
        filters={NO_BOARD_FILTERS}
        onChange={() => undefined}
      />,
    );
    const toggle = must(view.container.querySelector<HTMLButtonElement>('.fy-board-filters__toggle'), 'Filters');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('#board-filter-sheet')?.textContent).toContain('Filters');
  });

  it('S-0040 BoardSideTab: the cards-of-ferret panel is the side tab, one card per row', async () => {
    const root = await draw<PanelProps>(
      half?.panels['cards-of-ferret'],
      { subject: LEAD },
      node => node.querySelector('[data-task]') !== null,
      'the side tab drew a card',
    );
    expect(root.querySelector('[data-task="F1"]')?.textContent).toContain('Fix the scroller');
  });
});

describe('the lane editor and the board switch', () => {
  it('S-0128 LaneEditorPage: the board app owns the editor, reached at the project’s board with ?lanes=1', async () => {
    expect(projectLanesPath('abc')).toBe('/board/abc?lanes=1');
    await at(`/board/${PROJECT}?lanes=1`);
    const root = await draw<ScreenProps>(
      half?.screens.board,
      { params: { project: PROJECT } },
      node =>
        node.querySelector(`[data-lane-page="${PROJECT}"] [data-lane-editor], [data-lane-page="${PROJECT}"] h1`) !==
          null && (node.querySelector('h1')?.textContent ?? '').includes('ferretry'),
      'the lane editor page',
    );
    expect(root.querySelector('h1')?.textContent).toBe('Lanes · ferretry');
  });

  it('S-0041 BoardSwitchView: whether a project uses the board is Board’s route, read and put by the Projects app', () => {
    const routes = (manifest.actions?.routes ?? []).map(route => route.key);
    expect(routes).toContain('GET /v1/board/projects/:projectId/switch');
    expect(routes).toContain('PUT /v1/board/projects/:projectId/switch');
  });
});

describe('words and routes', () => {
  it('S-0333 feature tasks: a card’s name is drawn as a teammate prefix and the work', async () => {
    expect(parseWorkName('[Hayden] Fix the scroller')).toEqual({ prefix: 'Hayden', task: 'Fix the scroller' });
    expect(parseWorkName('Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
    expect(parseWorkName('fix [Hayden] later').prefix).toBeNull();
    view = await mount(<CardName name="[Hayden] Fix the scroller" />);
    expect(view.container.textContent).toBe('HaydenFix the scroller');
    expect(view.container.querySelector('[title]')?.getAttribute('title')).toBe('[Hayden] Fix the scroller');
  });

  it('S-0369 daemonBoardPath: the board is /board', () => {
    expect(boardPath()).toBe('/board');
  });

  it('S-0367 daemonBoardCardPath: a card id after /board opens that card; /card/<id> is its own page', () => {
    expect(boardCardPath(undefined, 'F12')).toBe('/board/F12');
    expect(cardPagePath('F12')).toBe('/card/F12');
  });

  it('S-0368 daemonBoardForFerretPath: a ferret’s board is the board narrowed by ?ferret=', () => {
    const ferret = 'mvuc7tsf-0c3d50df';
    const search = boardFiltersToSearch({ ...NO_BOARD_FILTERS, ferret }).toString();
    expect(new URLSearchParams(search).get('ferret')).toBe(ferret);
    expect(parseBoardFilters(search).ferret).toBe(ferret);
  });

  it('S-0449 board-for-ferret: the narrowing the "Board for <ferret>" destination opens is the same filter', () => {
    expect(parseBoardFilters('ferret=abc').ferret).toBe('abc');
  });
});
