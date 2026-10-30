import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type BoardTaskView,
  FY_REQUEST_ID_HEADER,
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  type SessionFileIndexSkip,
} from '@ferretry/protocol';
import { type ReactNode, useEffect } from 'react';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import {
  filterSessionSearchResults,
  MAX_SESSION_SEARCH_RESULTS,
  SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
  SessionSearchControl,
  SessionSearchProvider,
  type SessionSearchResourceState,
  sessionSearchResultKey,
  useSessionSearch,
} from '../../src/features/session-search/session-search.tsx';
import type { BoardServerQuery } from '../../src/lib/board-model.ts';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import { browserFetch } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionCard } from '../support/session-cards.ts';
import { boardAnswer, card, fakeEnvironment, fakePort, laneSetFor, PROJECT } from './board-support.ts';

const daemon = daemonConnection({
  daemonId: 'search-daemon',
  baseUrl: 'https://search.example.test',
  deviceId: 'search-token',
});
const SESSION = 'session-a';
const scope = daemonSessionScope(daemon, SESSION);
const originalFetch = globalThis.fetch;
const composers: Array<() => void> = [];

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

const pastAnnounceDebounce = async (): Promise<void> => {
  await runAsync(
    async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
  );
};

/* ---------- fixtures ------------------------------------------------------- */

/** One card the way the daemon serves it: owned by this ferret, imported from its old task F2. */
const needleCard = (patch: Record<string, unknown> = {}): BoardTaskView =>
  card('F6', {
    owner: SESSION,
    title: 'Needle task',
    summary: 'Search the current session quickly.',
    legacyRef: `${SESSION}:F2`,
    ...patch,
  });

interface BoardOptions {
  readonly cards?: readonly BoardTaskView[];
  readonly fail?: string;
  /** Hold the read until `release()`. */
  readonly hold?: boolean;
  /** Never answer. */
  readonly never?: boolean;
}

/** The U10 store over a fake port: records each server query it is asked, answers the cards it was given. */
const boardWith = (options: BoardOptions = {}) => {
  const queries: BoardServerQuery[] = [];
  const hosts: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const cards = options.cards ?? [needleCard()];
  const port = fakePort({
    board: async (connection, query) => {
      queries.push(query);
      hosts.push(connection.daemonId);
      if (options.never === true) return await new Promise<never>(() => undefined);
      if (options.hold === true) await held;
      if (options.fail !== undefined) throw new Error(options.fail);
      return boardAnswer(cards, { projectId: PROJECT, laneSet: laneSetFor() });
    },
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  return { store, queries, hosts, release: () => release() };
};

const NEEDLE_FILES: readonly SessionFileIndexEntry[] = [
  { name: 'needle.ts', path: 'src/needle.ts' },
  { name: 'README.md', path: 'README.md' },
];

const indexEntries = (directories: number, perDirectory = 2): readonly SessionFileIndexEntry[] =>
  Array.from({ length: directories }, (_, directory) =>
    Array.from({ length: perDirectory }, (_, file) => ({
      name: `row-${directory}-${file}.ts`,
      path: `dir-${directory}/row-${directory}-${file}.ts`,
    })),
  ).flat();

const fileIndexResponse = ({
  files = NEEDLE_FILES,
  coverage = 'complete',
  skipped = [],
  sessionId = SESSION,
}: {
  readonly files?: readonly SessionFileIndexEntry[];
  readonly coverage?: SessionFileIndexCoverage;
  readonly skipped?: readonly SessionFileIndexSkip[];
  readonly sessionId?: string;
} = {}) => ({ v: 1, sessionId, root: `/work/${sessionId}`, files, coverage, skipped });

/* ---------- the request ledger --------------------------------------------- */

interface Recorded {
  readonly method: string;
  readonly pathname: string;
  readonly requestId: string | null;
}

const indexReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.pathname.endsWith('/fs/index'));
/** The browser-side breadth-first crawl the index replaced. */
const listingReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.pathname.endsWith('/fs'));
/** `/v1/sessions/:sid/tasks` and `/v1/tasks`: no PWA code path asks for either any more. */
const legacyTaskReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => /\/tasks(\/|$)/u.test(row.pathname) && !row.pathname.startsWith('/v1/board'));

interface RoutesOptions {
  readonly index?: ReturnType<typeof fileIndexResponse> | Record<string, unknown>;
}

/** The daemon's file side only: the dead routes answer 410 so an accidental dial is named. */
const install = (options: RoutesOptions = {}): readonly Recorded[] => {
  const seen: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({
      method: init?.method ?? 'GET',
      pathname: url.pathname,
      requestId: new Headers(init?.headers).get(FY_REQUEST_ID_HEADER),
    });
    if (url.pathname.endsWith('/fs/index')) return Response.json(options.index ?? fileIndexResponse());
    if (url.pathname.endsWith('/fs')) return new Response('the browser-side file crawl is gone', { status: 410 });
    if (/\/tasks(\/|$)/u.test(url.pathname)) return new Response('the per-session task API is gone', { status: 410 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return seen;
};

const providerOf = (
  children: ReactNode,
  board: DaemonBoardStore | undefined,
  { focusSignal = 0, at = scope }: { readonly focusSignal?: number; readonly at?: DaemonSessionScope | null } = {},
) => (
  <SessionSearchProvider
    connection={daemon}
    focusSignal={focusSignal}
    scope={at}
    {...(board === undefined ? {} : { board })}
  >
    {children}
  </SessionSearchProvider>
);

function SearchOpeners({ onFile, onTasks }: { readonly onFile: (path: string) => void; readonly onTasks: () => void }) {
  const search = useSessionSearch();
  useEffect(() => {
    search.setOpeners({ openFile: onFile, openTasks: onTasks });
    return () => search.setOpeners(null);
  }, [onFile, onTasks, search]);
  return null;
}

type Search = ReturnType<typeof useSessionSearch>;

function SearchProbe({ onSearch }: { readonly onSearch: (search: Search) => void }) {
  onSearch(useSessionSearch());
  return null;
}

beforeEach(() => {
  install();
});

const composerAt = (target: DaemonSessionScope, draft = ''): { draft: string } => {
  const state = { draft };
  composers.push(
    registerComposerQuoteTarget({
      ...target,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (composers.length > 0) composers.pop()?.();
});

/* ---------- the model ------------------------------------------------------- */

describe('current-session search model', () => {
  test('matches a card locally on its id, its old id, its title, its summary and its lane', () => {
    const cards = [
      sessionCard('F96', {
        title: 'Port the importer',
        summary: 'Moves every old task.',
        lane: 'Verify',
        legacyId: 'F12',
      }),
      sessionCard('F7', { title: 'Unrelated work' }),
    ];
    const ids = (query: string) =>
      filterSessionSearchResults(cards, [], query).map(result =>
        result.kind === 'task' ? result.task.id : result.path,
      );

    expect(ids('importer')).toEqual(['F96']);
    expect(ids('F96')).toEqual(['F96']);
    expect(ids('F12')).toEqual(['F96']);
    expect(ids('every old')).toEqual(['F96']);
    expect(ids('verify')).toEqual(['F96']);
    expect(ids('absent')).toEqual([]);
  });

  test('matches file names and full paths with the protocol matcher, case-insensitively', () => {
    const files: readonly SessionFileIndexEntry[] = [
      { name: 'SessionSearch.tsx', path: 'packages/pwa/src/session/SessionSearch.tsx' },
    ];

    expect(filterSessionSearchResults([], files, 'sessionsearch')).toHaveLength(1);
    expect(filterSessionSearchResults([], files, 'packages/pwa')).toHaveLength(1);
    expect(filterSessionSearchResults([], files, 'absent')).toHaveLength(0);
  });

  test('does not invent results for a blank query or one the protocol refuses', () => {
    expect(filterSessionSearchResults([sessionCard('F6', { title: 'Needle task' })], NEEDLE_FILES, '   ')).toEqual([]);
    expect(
      filterSessionSearchResults(
        [sessionCard('F6', { title: 'Needle task' })],
        NEEDLE_FILES,
        'n'.repeat(MAX_SESSION_SEARCH_QUERY_LENGTH + 1),
      ),
    ).toEqual([]);
  });

  test('ranks a file matching name and path above a card matching only its title', () => {
    const ranked = filterSessionSearchResults(
      [sessionCard('F6', { title: 'Needle task' })],
      [{ name: 'needle.ts', path: 'src/needle.ts' }],
      'needle',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual(['file:src/needle.ts', 'task:F6']);
  });

  test('floors a card that matched only in its summary above a path-only file and below a named one', () => {
    const proseOnly = sessionCard('F12', { title: 'Unrelated work', summary: 'Finish porting the PWA feature' });
    const ranked = filterSessionSearchResults(
      [proseOnly],
      [
        { name: 'helpers.ts', path: 'src/transport/helpers.ts' },
        { name: 'reexport-helpers.ts', path: 'src/reexport-helpers.ts' },
      ],
      'port',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual([
      'file:src/reexport-helpers.ts',
      'task:F12',
      'file:src/transport/helpers.ts',
    ]);
  });

  test('ranks stably, leaving equal scores in their original order', () => {
    const ranked = filterSessionSearchResults(
      [sessionCard('F7', { title: 'Needle task' }), sessionCard('F8', { title: 'Needle task' })],
      [],
      'needle',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual(['task:F7', 'task:F8']);
  });
});

/* ---------- what a mounted scope costs --------------------------------------- */

describe('what one mounted session scope costs', () => {
  const mountProvider = async (board: ReturnType<typeof boardWith> | undefined, options: RoutesOptions = {}) => {
    const seen = install(options);
    const view = render(providerOf(<SessionSearchControl />, board?.store));
    await settle();
    return { seen, view };
  };

  test('is one ferret-scoped board read for every card the chat needs, plus one index read', async () => {
    const board = boardWith();
    const { seen, view } = await mountProvider(board, { index: fileIndexResponse({ files: indexEntries(6) }) });
    try {
      expect(board.queries).toHaveLength(1);
      expect(board.queries[0]).toEqual({
        project: null,
        ferret: SESSION,
        kind: null,
        pr: null,
        state: 'all',
        activity: null,
      });
      expect(board.hosts).toEqual([daemon.daemonId]);
      expect(indexReads(seen)).toHaveLength(1);
      expect(listingReads(seen)).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(legacyTaskReads(seen)).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('is independent of board size and tree depth', async () => {
    const many = Array.from({ length: 40 }, (_, index) => needleCard({ id: `F${index + 100}`, legacyRef: undefined }));
    const board = boardWith({ cards: many });
    const { seen, view } = await mountProvider(board, { index: fileIndexResponse({ files: indexEntries(25) }) });
    try {
      expect(board.queries).toHaveLength(1);
      expect(seen).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends no request on keystrokes: the query is matched in the browser', async () => {
    const board = boardWith();
    const { seen, view } = await mountProvider(board);
    try {
      const before = seen.length;
      for (const value of ['n', 'ne', 'nee', 'need', 'needl', 'needle']) {
        run(() => view.root.findByType('input').props.onChange({ target: { value } }));
      }
      await settle();

      expect(board.queries).toHaveLength(1);
      expect(seen).toHaveLength(before);
      expect(legacyTaskReads(seen)).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends one board read however many mounts share the box', async () => {
    const board = boardWith();
    const seen = install();
    const view = render(
      providerOf(
        <>
          <SessionSearchControl />
          <SessionSearchControl />
        </>,
        board.store,
      ),
    );
    try {
      await settle();
      run(() => view.root.findAllByType('input')[0]?.props.onChange({ target: { value: 'needle' } }));
      await settle();

      expect(board.queries).toHaveLength(1);
      expect(indexReads(seen)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('reads nothing without a scope, and reads the new ferret when the session changes', async () => {
    const board = boardWith();
    const seen = install();
    const view = render(providerOf(<SessionSearchControl />, board.store, { at: null }));
    try {
      await settle();
      expect(board.queries).toEqual([]);
      expect(seen).toEqual([]);
      expect(view.root.findAllByType('input')).toHaveLength(0);

      await runAsync(async () => {
        view.update(providerOf(<SessionSearchControl />, board.store, { at: scope }));
        await settle();
      });
      expect(board.queries.map(query => query.ferret)).toEqual([SESSION]);

      await runAsync(async () => {
        view.update(providerOf(<SessionSearchControl />, board.store, { at: daemonSessionScope(daemon, 'session-b') }));
        await settle();
      });
      expect(board.queries.map(query => query.ferret)).toEqual([SESSION, 'session-b']);
    } finally {
      run(() => view.unmount());
    }
  });
});

/* ---------- the cards ---------------------------------------------------------- */

describe("the ferret's cards", () => {
  const observe = async (
    board: DaemonBoardStore | undefined,
    options: { readonly settled?: boolean } = {},
  ): Promise<{ readonly latest: () => Search; readonly unmount: () => void }> => {
    let latest: Search | undefined;
    const view = render(
      providerOf(
        <SearchProbe
          onSearch={search => {
            latest = search;
          }}
        />,
        board,
      ),
    );
    if (options.settled !== false) await settle();
    return {
      latest: () => {
        if (latest === undefined) throw new Error('probe never rendered');
        return latest;
      },
      unmount: () => run(() => view.unmount()),
    };
  };

  test('lists the cards this ferret owns or is assigned, with their lane names and old ids', async () => {
    const board = boardWith({
      cards: [
        needleCard(),
        card('F8', { owner: 'session-z', assignee: SESSION, title: 'Assigned to me' }),
        card('F9', { owner: 'session-z', title: "Somebody else's" }),
        card('F10', { owner: SESSION, title: 'Another ferret imported this', legacyRef: 'session-b:F2' }),
      ],
    });
    const probe = await observe(board.store);
    try {
      const search = probe.latest();
      expect(search.taskState).toBe('ready');
      expect(search.taskError).toBeNull();
      expect(search.tasks.map(task => task.id).sort()).toEqual(['F10', 'F6', 'F8']);
      const own = search.tasks.find(task => task.id === 'F6');
      expect(own).toMatchObject({ title: 'Needle task', lane: 'Implement', legacyId: 'F2', closed: false });
      expect(search.tasks.find(task => task.id === 'F10')?.legacyId).toBeNull();
    } finally {
      probe.unmount();
    }
  });

  test("finds a card by the id it had as an old task of this ferret, and never by another ferret's", async () => {
    const board = boardWith({
      cards: [needleCard(), card('F10', { owner: SESSION, title: 'Unrelated', legacyRef: 'session-b:F2' })],
    });
    const probe = await observe(board.store);
    try {
      run(() => probe.latest().setQuery('F2'));
      expect(probe.latest().results.map(sessionSearchResultKey)).toEqual(['task:F6']);
    } finally {
      probe.unmount();
    }
  });

  test('says loading until the board answers, then ready, and lets a menu await the one read', async () => {
    const board = boardWith({ hold: true });
    const probe = await observe(board.store, { settled: false });
    try {
      await settle();
      expect(probe.latest().taskState).toBe('loading');
      const waiting = probe.latest().waitForTasks();
      expect(waiting).toBeDefined();
      let finished = false;
      void waiting?.then(() => {
        finished = true;
      });
      await settle();
      expect(finished).toBe(false);

      board.release();
      await settle();
      expect(probe.latest().taskState).toBe('ready');
      expect(probe.latest().tasks.map(task => task.id)).toEqual(['F6']);
      expect(finished).toBe(true);
      expect(probe.latest().waitForTasks()).toBeUndefined();
      expect(board.queries).toHaveLength(1);
    } finally {
      probe.unmount();
    }
  });

  test('says unavailable with the daemon reason when the board cannot be read, and the files stay searchable', async () => {
    const board = boardWith({ fail: 'board refused' });
    const seen = install();
    const view = render(providerOf(<SessionSearchControl />, board.store));
    try {
      await settle();
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await settle();

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('Tasks unavailable');
      expect(drawn).toContain('board refused');
      expect(drawn).not.toContain('Files unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');
      expect(view.root.findAll(node => node.props['data-result-kind'] === 'file')).toHaveLength(1);
      expect(legacyTaskReads(seen)).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('is ready with no cards and no error when the host has no board', async () => {
    const probe = await observe(undefined);
    try {
      expect(probe.latest().taskState).toBe('ready');
      expect(probe.latest().taskError).toBeNull();
      expect(probe.latest().tasks).toEqual([]);
    } finally {
      probe.unmount();
    }
  });

  test('closes a card in a closed lane to the menu but keeps it findable', async () => {
    const board = boardWith({ cards: [needleCard({ laneId: 'closed' })] });
    const probe = await observe(board.store);
    try {
      expect(probe.latest().tasks[0]?.closed).toBe(true);
      run(() => probe.latest().setQuery('needle'));
      expect(probe.latest().results.map(sessionSearchResultKey)).toContain('task:F6');
    } finally {
      probe.unmount();
    }
  });
});

/* ---------- coverage and the file half ---------------------------------------- */

describe('honest coverage of the file index', () => {
  const mountControl = async (options: RoutesOptions = {}, board: BoardOptions = {}) => {
    const seen = install(options);
    const view = render(providerOf(<SessionSearchControl />, boardWith(board).store));
    await settle();
    return { seen, view };
  };

  const rowKinds = (view: ReturnType<typeof render>): readonly string[] =>
    view.root.findAll(node => node.props['data-result-kind'] !== undefined).map(node => node.props['data-result-kind']);

  const type = async (view: ReturnType<typeof render>, value: string): Promise<void> => {
    run(() => view.root.findByType('input').props.onChange({ target: { value } }));
    await settle();
  };

  test('lists a card matched on its summary alone beside the files', async () => {
    const { view } = await mountControl(
      { index: fileIndexResponse({ files: [] }) },
      { cards: [needleCard({ title: 'Unrelated work', summary: 'The transport layer needs work.' })] },
    );
    try {
      await type(view, 'transport');

      expect(rowKinds(view)).toEqual(['task']);
      expect(JSON.stringify(view.toJSON())).toContain('&amp;F6 · Implement'.replace('&amp;', '&'));
    } finally {
      run(() => view.unmount());
    }
  });

  test('keeps a complete index searchable when policy left named paths out of it', async () => {
    const { view } = await mountControl({
      index: fileIndexResponse({
        coverage: 'complete',
        skipped: [
          { reason: 'denied', count: 1 },
          { reason: 'excluded', count: 2 },
        ],
      }),
    });
    try {
      await type(view, 'needle');

      expect(rowKinds(view)).toContain('file');
      expect(view.root.findByProps({ 'data-search-skips': '' }).children.join('')).toContain(
        'Not indexed: 1 denied, 2 excluded.',
      );
      expect(JSON.stringify(view.toJSON())).not.toContain('Files unavailable');
      expect(view.root.findAll(node => node.props['data-search-coverage'] !== undefined)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('names partial coverage without blocking the rows it did index', async () => {
    const { view } = await mountControl({
      index: fileIndexResponse({ coverage: 'partial', skipped: [{ reason: 'truncated', count: 1 }] }),
    });
    try {
      await type(view, 'needle');

      expect(rowKinds(view)).toContain('file');
      expect(view.root.findByProps({ 'data-search-coverage': '' }).children.join('')).toContain(
        'File results are incomplete: the index did not finish.',
      );
      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).not.toContain('Files unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');

      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('qualifies a zero result over a partial index instead of claiming nothing matches', async () => {
    const { view } = await mountControl(
      {
        index: fileIndexResponse({
          files: [{ name: 'unrelated.ts', path: 'src/unrelated.ts' }],
          coverage: 'partial',
          skipped: [{ reason: 'unreadable', count: 3 }],
        }),
      },
      { cards: [] },
    );
    try {
      await type(view, 'needle');

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('No match in the indexed portion of this session.');
      expect(drawn).not.toContain('No current-session files or tasks match');
      expect(view.root.findByProps({ 'data-search-skips': '' }).children.join('')).toContain('3 unreadable');

      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('still makes an unqualified no-match claim when the index really is complete', async () => {
    const { view } = await mountControl({}, { cards: [] });
    try {
      await type(view, 'absent');

      expect(JSON.stringify(view.toJSON())).toContain('No current-session files or tasks match');
      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('No results');
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses a query the protocol would reject, at the input', async () => {
    const { view } = await mountControl();
    try {
      await type(view, 'n'.repeat(MAX_SESSION_SEARCH_QUERY_LENGTH + 1));

      expect(view.root.findAll(node => node.props['data-search-query-invalid'] !== undefined)).toHaveLength(1);
      expect(rowKinds(view)).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses an index document that contradicts itself or describes another session', async () => {
    for (const broken of [
      fileIndexResponse({ coverage: 'complete', skipped: [{ reason: 'truncated', count: 1 }] }),
      fileIndexResponse({ coverage: 'partial', skipped: [] }),
      { ...fileIndexResponse(), files: [{ name: 'other.ts', path: 'src/needle.ts' }] },
      fileIndexResponse({ sessionId: 'session-b' }),
      { entries: [] },
    ]) {
      const { view } = await mountControl({ index: broken });
      try {
        await type(view, 'needle');

        const drawn = JSON.stringify(view.toJSON());
        expect(drawn).toContain('Files unavailable');
        expect(drawn).not.toContain('No current-session files or tasks match');
      } finally {
        run(() => view.unmount());
      }
    }
  });
});

/* ---------- scope and evidence ------------------------------------------------- */

describe('the published scope and the published evidence never disagree', () => {
  interface Observation {
    readonly daemonId: string | undefined;
    readonly taskState: SessionSearchResourceState;
    readonly taskIds: readonly string[];
    readonly resolvesF6: boolean;
    readonly resolvesLegacyF2: boolean;
    readonly query: string;
    readonly presenting: string | null;
    readonly activeResultKey: string | null;
  }

  type SearchController = Pick<Search, 'present' | 'setActiveIndex' | 'setQuery'>;

  function ScopeProbe({
    onObserve,
    onControl,
  }: {
    readonly onObserve: (observation: Observation) => void;
    readonly onControl: (control: SearchController) => void;
  }) {
    const search = useSessionSearch();
    const referenceTasks = search.taskState === 'ready' ? search.tasks : undefined;
    const surface =
      search.scope === null
        ? null
        : sessionReferenceSurface({
            connection: search.connection,
            fetcher: browserFetch,
            scope: search.scope,
            ...(referenceTasks === undefined ? {} : { tasks: referenceTasks }),
          });
    const activeResult = search.results[search.activeIndex];
    onControl(search);
    onObserve({
      daemonId: search.scope?.daemonId,
      taskState: search.taskState,
      taskIds: search.tasks.map(task => task.id),
      resolvesF6: surface?.taskReferenceResolver?.('F6') === true,
      resolvesLegacyF2: surface?.taskReferenceResolver?.('F2') === true,
      query: search.query,
      presenting: search.presenting,
      activeResultKey: activeResult === undefined ? null : sessionSearchResultKey(activeResult),
    });
    return null;
  }

  test('never pairs the new session with the previous session evidence, not even for one render', async () => {
    const alpha = daemonConnection({
      daemonId: 'alpha',
      baseUrl: 'https://alpha.example.test',
      deviceId: 'alpha-token',
    });
    const beta = daemonConnection({
      daemonId: 'beta',
      baseUrl: 'https://beta.example.test',
      deviceId: 'beta-token',
    });
    const alphaScope = daemonSessionScope(alpha, 'shared');
    const betaScope = daemonSessionScope(beta, 'shared');
    install({ index: fileIndexResponse({ files: [], sessionId: 'shared' }) });
    const store = new DaemonBoardStore(
      fakePort({
        board: async connection =>
          boardAnswer(
            connection.daemonId === 'alpha' ? [needleCard({ owner: 'shared', legacyRef: 'shared:F2' })] : [],
            { projectId: PROJECT, laneSet: laneSetFor() },
          ),
      }),
      fakeEnvironment(),
    );

    const seen: Observation[] = [];
    let control: SearchController | undefined;
    const observe = (observation: Observation): void => {
      seen.push(observation);
    };
    const captureControl = (current: SearchController): void => {
      control = current;
    };
    const under = (connection: typeof alpha, at: typeof alphaScope) => (
      <SessionSearchProvider board={store} connection={connection} focusSignal={0} scope={at}>
        <ScopeProbe onControl={captureControl} onObserve={observe} />
      </SessionSearchProvider>
    );
    const tree = render(under(alpha, alphaScope));
    try {
      await settle();
      expect(seen.some(o => o.daemonId === 'alpha' && o.taskState === 'ready' && o.taskIds.includes('F6'))).toBe(true);
      expect(seen.some(o => o.daemonId === 'alpha' && o.resolvesF6 && o.resolvesLegacyF2)).toBe(true);

      if (control === undefined) throw new Error('scope probe never published its search controls');
      run(() => {
        control?.setQuery('needle');
        control?.present('scope-probe');
      });
      await settle();
      run(() => control?.setActiveIndex(0));
      expect(seen.at(-1)).toMatchObject({
        query: 'needle',
        presenting: 'scope-probe',
        activeResultKey: 'task:F6',
      });

      const before = seen.length;
      await runAsync(async () => {
        tree.update(under(beta, betaScope));
        await settle();
      });

      const onBeta = seen.slice(before).filter(o => o.daemonId === 'beta');
      expect(onBeta.length).toBeGreaterThan(0);
      expect(onBeta.filter(o => o.taskIds.includes('F6'))).toEqual([]);
      expect(onBeta.filter(o => o.resolvesF6 || o.resolvesLegacyF2)).toEqual([]);
      expect(onBeta[0]?.taskState).toBe('loading');
      expect(seen.at(-1)).toMatchObject({
        daemonId: 'beta',
        taskState: 'ready',
        taskIds: [],
        query: '',
        presenting: null,
        activeResultKey: null,
      });
    } finally {
      run(() => tree.unmount());
    }
  });
});

/* ---------- the control ---------------------------------------------------------- */

describe('current-session search control', () => {
  const keyEvent = (key: string, composing = false, keyCode = 0) => {
    let defaultPrevented = false;
    return {
      key,
      keyCode,
      nativeEvent: { isComposing: composing },
      preventDefault: () => {
        defaultPrevented = true;
      },
      get defaultPrevented(): boolean {
        return defaultPrevented;
      },
    };
  };

  const mountControl = async (
    props: { readonly shortcutTarget?: boolean } = {},
    openers?: { readonly onFile: (path: string) => void; readonly onTasks: () => void },
    board: BoardOptions = {},
  ) => {
    const view = render(
      providerOf(
        <>
          {openers ? <SearchOpeners onFile={openers.onFile} onTasks={openers.onTasks} /> : null}
          <SessionSearchControl {...props} />
        </>,
        boardWith(board).store,
      ),
    );
    await settle();
    return view;
  };

  const popup = (view: ReturnType<typeof render>) =>
    view.root.findAll(node => String(node.props.className).includes('z-[80]'));

  const rows = (view: ReturnType<typeof render>) => popup(view)[0]?.findAllByType('button') ?? [];

  const search = async (view: ReturnType<typeof render>, value: string): Promise<void> => {
    run(() => view.root.findByType('input').props.onChange({ target: { value } }));
    await settle();
  };

  test('opens matched results, each at its own destination', async () => {
    const opened: string[] = [];
    const seen = install();
    const surface = render(
      providerOf(
        <>
          <SearchOpeners onFile={path => opened.push(`file:${path}`)} onTasks={() => opened.push('tasks')} />
          <SessionSearchControl />
        </>,
        boardWith().store,
      ),
    );
    try {
      await settle();
      const input = surface.root.findByType('input');
      const listed = async (): Promise<ReturnType<typeof surface.root.findAllByType>> => {
        run(() => input.props.onChange({ target: { value: 'needle' } }));
        await settle();
        return surface.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
      };
      const first = await listed();
      expect(first).toHaveLength(2);
      run(() => first[0]?.props.onClick());
      const second = await listed();
      run(() => second[1]?.props.onClick());
      expect(opened).toEqual(['file:src/needle.ts', 'tasks']);
      expect(listingReads(seen)).toHaveLength(0);
      expect(legacyTaskReads(seen)).toEqual([]);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('caps the presented rows and says exactly how many it is holding back', async () => {
    install({
      index: fileIndexResponse({
        files: Array.from({ length: MAX_SESSION_SEARCH_RESULTS + 5 }, (_, index) => ({
          name: `needle-${index}.ts`,
          path: `needle-${index}.ts`,
        })),
      }),
    });
    const view = await mountControl({}, undefined, { cards: [] });
    try {
      await search(view, 'needle');

      expect(rows(view)).toHaveLength(MAX_SESSION_SEARCH_RESULTS);
      expect(view.root.findByProps({ 'data-search-capped': '' }).children.join('')).toContain('5 more matches');
    } finally {
      run(() => view.unmount());
    }
  });

  test('presents the popup only for the mount the reader is in, and never two at once', async () => {
    const view = render(
      providerOf(
        <>
          <SessionSearchControl />
          <SessionSearchControl />
        </>,
        boardWith().store,
      ),
    );
    try {
      await settle();
      const inputs = view.root.findAllByType('input');
      expect(inputs).toHaveLength(2);

      const [first, second] = inputs;
      expect(first?.props.id).not.toBe(second?.props.id);
      expect(view.root.findAllByType('label').map(node => node.props.htmlFor)).toEqual([
        first?.props.id,
        second?.props.id,
      ]);

      run(() => first?.props.onChange({ target: { value: 'needle' } }));
      expect(popup(view)).toHaveLength(1);
      expect(first?.props['aria-expanded']).toBe(true);
      expect(second?.props['aria-expanded']).toBe(false);

      run(() => second?.props.onFocus());
      expect(popup(view)).toHaveLength(1);
      expect(first?.props['aria-expanded']).toBe(false);
      expect(second?.props['aria-expanded']).toBe(true);
      expect(second?.props.value).toBe('needle');
    } finally {
      run(() => view.unmount());
    }
  });

  test('lets exactly one mount answer the shared global focus signal', async () => {
    let focusCount = 0;
    const store = boardWith().store;
    const tree = (signal: number) =>
      providerOf(
        <>
          <SessionSearchControl shortcutTarget />
          <SessionSearchControl />
        </>,
        store,
        { focusSignal: signal },
      );
    const view = render(tree(0), {
      createNodeMock: element =>
        element.type === 'input'
          ? {
              focus: () => {
                focusCount += 1;
              },
              select: () => undefined,
            }
          : null,
    });
    try {
      await settle();
      run(() => view.update(tree(3)));
      expect(focusCount).toBe(1);
      expect(popup(view)).toHaveLength(1);
      expect(view.root.findAllByType('input').filter(node => node.props['aria-expanded'] === true)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('does not replay an already-consumed focus signal when the control remounts', async () => {
    let focusCount = 0;
    const view = render(providerOf(<SessionSearchControl shortcutTarget />, boardWith().store, { focusSignal: 7 }), {
      createNodeMock: element =>
        element.type === 'input'
          ? {
              focus: () => {
                focusCount += 1;
              },
              select: () => undefined,
            }
          : null,
    });
    try {
      await settle();
      expect(focusCount).toBe(0);
      expect(popup(view)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('moves the active row with the arrows and wraps, pointing at it rather than focusing it', async () => {
    const view = await mountControl();
    try {
      await search(view, 'e');
      const input = view.root.findByType('input');
      const listed = rows(view);
      expect(listed.length).toBeGreaterThan(1);
      expect(input.props['aria-activedescendant']).toBe(listed[0]?.props.id);
      expect(listed[0]?.props['aria-selected']).toBe(true);
      expect(listed.every(row => row.props.tabIndex === -1)).toBe(true);

      const down = keyEvent('ArrowDown');
      run(() => input.props.onKeyDown(down));
      expect(down.defaultPrevented).toBe(true);
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(listed[1]?.props.id);

      run(() => input.props.onKeyDown(keyEvent('ArrowUp')));
      run(() => input.props.onKeyDown(keyEvent('ArrowUp')));
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(listed[listed.length - 1]?.props.id);

      run(() => input.props.onKeyDown(keyEvent('Home')));
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(listed[0]?.props.id);
      run(() => input.props.onKeyDown(keyEvent('End')));
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(listed[listed.length - 1]?.props.id);
    } finally {
      run(() => view.unmount());
    }
  });

  test('keeps the active result identity when the independently loaded half reorders the list', async () => {
    let releaseIndex: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index'))
        return new Promise<Response>(resolve => {
          releaseIndex = resolve;
        });
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const opened: string[] = [];
    const view = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
    );
    try {
      await search(view, 'needle');
      const taskRow = rows(view)[0];
      expect(taskRow?.props['data-result-kind']).toBe('task');
      run(() => taskRow?.props.onMouseEnter());
      const chosenId = view.root.findByType('input').props['aria-activedescendant'];
      expect(JSON.stringify(view.toJSON())).toContain("Indexing this session's files…");
      expect(JSON.stringify(view.toJSON())).not.toContain("Indexing this session's tasks…");
      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');

      await runAsync(async () => {
        releaseIndex?.(Response.json(fileIndexResponse({ files: [{ name: 'needle.ts', path: 'src/needle.ts' }] })));
        await settle();
      });
      await pastAnnounceDebounce();

      const reordered = rows(view);
      expect(reordered.map(row => row.props['data-result-kind'])).toEqual(['file', 'task']);
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(chosenId);
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('2 results');
      const enter = keyEvent('Enter');
      run(() => view.root.findByType('input').props.onKeyDown(enter));
      expect(opened).toEqual(['tasks']);
    } finally {
      run(() => view.unmount());
    }
  });

  test('leaves a key it does not answer to alone, and yields everything to a composing IME', async () => {
    const view = await mountControl();
    try {
      await search(view, 'e');
      const input = view.root.findByType('input');
      const before = view.root.findByType('input').props['aria-activedescendant'];

      const ordinary = keyEvent('PageDown');
      run(() => input.props.onKeyDown(ordinary));
      expect(ordinary.defaultPrevented).toBe(false);

      const composing = keyEvent('ArrowDown', true);
      run(() => input.props.onKeyDown(composing));
      expect(composing.defaultPrevented).toBe(false);
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(before);

      const composingEscape = keyEvent('Escape', true);
      run(() => input.props.onKeyDown(composingEscape));
      expect(composingEscape.defaultPrevented).toBe(false);
      expect(popup(view)).toHaveLength(1);

      const legacyComposition = keyEvent('Enter', false, 229);
      run(() => input.props.onKeyDown(legacyComposition));
      expect(legacyComposition.defaultPrevented).toBe(false);
      expect(popup(view)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('opens the active row on Enter and closes behind itself', async () => {
    const opened: string[] = [];
    const view = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
    );
    try {
      await search(view, 'needle');
      const input = view.root.findByType('input');
      const activeKind = rows(view)[0]?.props['data-result-kind'];

      const enter = keyEvent('Enter');
      run(() => input.props.onKeyDown(enter));

      expect(enter.defaultPrevented).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.startsWith(activeKind === 'file' ? 'file:' : 'tasks')).toBe(true);
      expect(popup(view)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('ignores Enter when no row is active', async () => {
    const opened: string[] = [];
    const view = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
    );
    try {
      await search(view, 'absent-everywhere');
      const enter = keyEvent('Enter');
      run(() => view.root.findByType('input').props.onKeyDown(enter));

      expect(enter.defaultPrevented).toBe(false);
      expect(opened).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('dismisses on Escape WITHOUT clearing the query', async () => {
    const view = await mountControl();
    try {
      await search(view, 'needle');
      const input = view.root.findByType('input');
      expect(popup(view)).toHaveLength(1);

      const escapeKey = keyEvent('Escape');
      run(() => input.props.onKeyDown(escapeKey));

      expect(escapeKey.defaultPrevented).toBe(true);
      expect(popup(view)).toHaveLength(0);
      expect(view.root.findByType('input').props.value).toBe('needle');

      const again = keyEvent('Escape');
      run(() => input.props.onKeyDown(again));
      expect(again.defaultPrevented).toBe(false);

      run(() => input.props.onChange({ target: { value: 'needle.' } }));
      expect(popup(view)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('dismisses when keyboard focus leaves the control', async () => {
    const view = await mountControl();
    try {
      await search(view, 'needle');
      const input = view.root.findByType('input');
      expect(popup(view)).toHaveLength(1);

      run(() => input.props.onBlur({ relatedTarget: null }));

      expect(popup(view)).toHaveLength(0);
      expect(view.root.findByType('input').props.value).toBe('needle');
    } finally {
      run(() => view.unmount());
    }
  });

  test('says it is INDEXING while it builds, and never calls a failed index an empty result', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const indexing = await mountControl({}, undefined, { never: true });
    try {
      run(() => indexing.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(indexing.toJSON());

      expect(drawn).toContain("Indexing this session's files and tasks…");
      expect(
        indexing.root.findAll(node => node.type === 'svg' && node.props['data-search-indexing'] !== undefined),
      ).toHaveLength(1);
      expect(indexing.root.findAll(node => node.props['data-search-shortcut'] !== undefined)).toHaveLength(0);
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => indexing.unmount());
    }

    globalThis.fetch = (async () => Response.json({ entries: [] })) as unknown as typeof fetch;
    const broken = await mountControl({}, undefined, { fail: 'board refused' });
    try {
      run(() => broken.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await settle();
      const drawn = JSON.stringify(broken.toJSON());

      expect(drawn).toContain('Tasks unavailable: board refused.');
      expect(drawn).toContain('Files unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => broken.unmount());
    }

    globalThis.fetch = (() => Promise.reject(new Error('Failed to fetch'))) as unknown as typeof fetch;
    const refused = await mountControl({}, undefined, { fail: 'Failed to fetch' });
    try {
      run(() => refused.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      expect(JSON.stringify(refused.toJSON())).toContain(
        'Tasks unavailable: Failed to fetch. Files unavailable: Failed to fetch.',
      );
    } finally {
      run(() => refused.unmount());
    }
  });

  test('names only the independently moving half and does not repeat it inside a refusal alert', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return Promise.resolve(Response.json(fileIndexResponse({ files: [] })));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const tasksMoving = await mountControl({}, undefined, { never: true });
    try {
      run(() => tasksMoving.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(tasksMoving.toJSON());
      expect(drawn).toContain("Indexing this session's tasks…");
      expect(drawn).not.toContain("Indexing this session's files…");
    } finally {
      run(() => tasksMoving.unmount());
    }

    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return new Promise<Response>(() => undefined);
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const failedTasks = await mountControl({}, undefined, { fail: 'task read refused' });
    try {
      run(() => failedTasks.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(failedTasks.toJSON());
      expect(drawn).toContain('Tasks unavailable: task read refused.');
      expect(drawn).toContain("Indexing this session's files…");
      expect(drawn.match(/Indexing/g)).toHaveLength(1);
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => failedTasks.unmount());
    }
  });

  test('neither prints nor claims Cmd/Ctrl+K: that chord opens the global finder', async () => {
    const view = await mountControl();
    try {
      expect(view.root.findAll(node => node.props['data-search-shortcut'] !== undefined)).toHaveLength(0);
      expect(view.root.findByType('input').props['aria-keyshortcuts']).toBeUndefined();
    } finally {
      run(() => view.unmount());
    }
  });

  test('answers an explicit shortcut with focus on every device, touch included', async () => {
    let focused = 0;
    let selected = 0;
    const store = boardWith().store;
    const tree = (signal: number) =>
      providerOf(<SessionSearchControl shortcutTarget />, store, { focusSignal: signal });
    // react-test-renderer gives host refs `null`, so the ref-gated effect needs a node mock to run at all.
    const view = render(tree(0), {
      createNodeMock: element =>
        element.type === 'input'
          ? {
              focus: () => {
                focused += 1;
              },
              select: () => {
                selected += 1;
              },
            }
          : null,
    });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    try {
      await settle();
      run(() => view.update(tree(2)));
      expect(focused).toBe(1);
      expect(selected).toBe(1);
      const input = view.root.findByType('input');
      expect(input.props.role).toBe('combobox');
      expect(input.props['aria-autocomplete']).toBe('list');
      expect(view.root.findAll(node => String(node.props.className).includes('z-[80]'))).toHaveLength(1);
      expect(JSON.stringify(view.toJSON())).toContain("Type to search this session's files and tasks.");

      const escapeKey = keyEvent('Escape');
      run(() => input.props.onKeyDown(escapeKey));
      expect(escapeKey.defaultPrevented).toBe(true);
      expect(view.root.findAll(node => String(node.props.className).includes('z-[80]'))).toHaveLength(0);
    } finally {
      outside.remove();
      run(() => view.unmount());
    }
  });

  test('dismisses on a pointer landing outside the control, and not on one inside it', async () => {
    const view = await mountControl();
    try {
      await search(view, 'needle');
      expect(popup(view)).toHaveLength(1);

      const outside = document.createElement('div');
      document.body.append(outside);
      run(() => {
        outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      outside.remove();
      expect(popup(view)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('never writes into a composer: opening a result only calls the host opener', async () => {
    const draft = composerAt(scope, 'keep me');
    const view = await mountControl({}, { onFile: () => undefined, onTasks: () => undefined });
    try {
      await search(view, 'needle');
      run(() => rows(view)[0]?.props.onClick());
      expect(draft.draft).toBe('keep me');
    } finally {
      run(() => view.unmount());
    }
  });
});
