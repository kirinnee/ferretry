/**
 * Current-ferret file and card search: the ranking model, what one mounted scope costs, the ferret's cards as Board
 * hands them in, honest file-index coverage, the scope/evidence pairing, and the combobox control.
 */

import { describe, expect, test } from 'bun:test';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import { type ReactNode, useEffect } from 'react';
import {
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  type SessionFileIndexSkip,
} from '../../../../app/search/ferret-file-index.ts';
import {
  type FerretCardsRead,
  type FerretSearchCard,
  type FerretSearchScope,
  filterSessionSearchResults,
  MAX_SESSION_SEARCH_RESULTS,
  SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
  SessionSearchControl,
  SessionSearchProvider,
  type SessionSearchResourceState,
  sessionSearchResultKey,
  useSessionSearch,
} from '../../../../app/search/session-search.tsx';
import { type CallHandler, type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

const INDEX = 'GET /v1/ferrets/:ferretId/fs/index';
const FERRET = 'ferret-a';
const SCOPE: FerretSearchScope = { daemon: 'search-daemon', ferret: FERRET };

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

const cardOf = (id: string, patch: Partial<FerretSearchCard> = {}): FerretSearchCard => ({
  id,
  title: 'Untitled',
  summary: '',
  lane: 'Implement',
  ...patch,
});

/** This ferret's one card, the way Board hands it in. */
const needleCard = (patch: Partial<FerretSearchCard> = {}): FerretSearchCard =>
  cardOf('F6', { title: 'Needle task', summary: 'Search the current ferret quickly.', ...patch });

const cardsRead = (
  cards: readonly FerretSearchCard[] = [needleCard()],
  state: SessionSearchResourceState = 'ready',
  error: string | null = null,
): FerretCardsRead => ({ state, error, cards });

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
  sessionId = FERRET,
}: {
  readonly files?: readonly SessionFileIndexEntry[];
  readonly coverage?: SessionFileIndexCoverage;
  readonly skipped?: readonly SessionFileIndexSkip[];
  readonly sessionId?: string;
} = {}) => ({ v: 1, sessionId, root: `/work/${sessionId}`, files, coverage, skipped });

/** The index of whichever ferret was asked about. */
const answersIndex =
  (options: Omit<Parameters<typeof fileIndexResponse>[0] & object, 'sessionId'> = {}): CallHandler =>
  call =>
    fileIndexResponse({ ...options, sessionId: call.params.ferretId ?? FERRET });

const neverAnswers: CallHandler = () => new Promise<never>(() => undefined);

/** A client whose file index is `handler` (the needle index by default). Any other route is a named failure. */
const clientWith = (handler: CallHandler = answersIndex(), daemon = SCOPE.daemon): FakeClient =>
  fakeClient({ [INDEX]: handler }, daemon);

const providerOf = (
  children: ReactNode,
  client: FakeClient,
  {
    cards = cardsRead(),
    focusSignal = 0,
    at = SCOPE,
  }: {
    /** `null`: the host has no board and hands no cards in. */
    readonly cards?: FerretCardsRead | null;
    readonly focusSignal?: number;
    readonly at?: FerretSearchScope | null;
  } = {},
) =>
  withClient(
    client,
    <SessionSearchProvider focusSignal={focusSignal} scope={at} {...(cards === null ? {} : { cards })}>
      {children}
    </SessionSearchProvider>,
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

/* ---------- the model ------------------------------------------------------- */

describe('current-ferret search model', () => {
  test('matches a card locally on its id, its title, its summary and its lane', () => {
    const cards = [
      cardOf('F96', { title: 'Port the importer', summary: 'Moves every old task.', lane: 'Verify' }),
      cardOf('F7', { title: 'Unrelated work' }),
    ];
    const ids = (query: string) =>
      filterSessionSearchResults(cards, [], query).map(result =>
        result.kind === 'task' ? result.task.id : result.path,
      );

    expect(ids('importer')).toEqual(['F96']);
    expect(ids('F96')).toEqual(['F96']);
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
    expect(filterSessionSearchResults([cardOf('F6', { title: 'Needle task' })], NEEDLE_FILES, '   ')).toEqual([]);
    expect(
      filterSessionSearchResults(
        [cardOf('F6', { title: 'Needle task' })],
        NEEDLE_FILES,
        'n'.repeat(MAX_SESSION_SEARCH_QUERY_LENGTH + 1),
      ),
    ).toEqual([]);
  });

  test('ranks a file matching name and path above a card matching only its title', () => {
    const ranked = filterSessionSearchResults(
      [cardOf('F6', { title: 'Needle task' })],
      [{ name: 'needle.ts', path: 'src/needle.ts' }],
      'needle',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual(['file:src/needle.ts', 'task:F6']);
  });

  test('floors a card that matched only in its summary above a path-only file and below a named one', () => {
    const proseOnly = cardOf('F12', { title: 'Unrelated work', summary: 'Finish porting the PWA feature' });
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
      [cardOf('F7', { title: 'Needle task' }), cardOf('F8', { title: 'Needle task' })],
      [],
      'needle',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual(['task:F7', 'task:F8']);
  });
});

/* ---------- what a mounted scope costs --------------------------------------- */

describe('what one mounted ferret scope costs', () => {
  const mountProvider = async (client: FakeClient, cards: FerretCardsRead = cardsRead()) => {
    const view = render(providerOf(<SessionSearchControl />, client, { cards }));
    await settle();
    return view;
  };

  test("is one index read of this ferret, through the half's client, and nothing else", async () => {
    const client = clientWith(answersIndex({ files: indexEntries(6) }));
    const view = await mountProvider(client);
    try {
      expect(client.callsTo(INDEX)).toHaveLength(1);
      expect(client.callsTo(INDEX)[0]?.params).toEqual({ ferretId: FERRET });
      expect(client.calls).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('is independent of board size and tree depth', async () => {
    const many = Array.from({ length: 40 }, (_, index) => needleCard({ id: `F${index + 100}` }));
    const client = clientWith(answersIndex({ files: indexEntries(25) }));
    const view = await mountProvider(client, cardsRead(many));
    try {
      expect(client.calls).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends no request on keystrokes: the query is matched in the browser', async () => {
    const client = clientWith();
    const view = await mountProvider(client);
    try {
      const before = client.calls.length;
      for (const value of ['n', 'ne', 'nee', 'need', 'needl', 'needle']) {
        run(() => view.root.findByType('input').props.onChange({ target: { value } }));
      }
      await settle();

      expect(client.calls).toHaveLength(before);
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends one index read however many mounts share the box', async () => {
    const client = clientWith();
    const view = render(
      providerOf(
        <>
          <SessionSearchControl />
          <SessionSearchControl />
        </>,
        client,
      ),
    );
    try {
      await settle();
      run(() => view.root.findAllByType('input')[0]?.props.onChange({ target: { value: 'needle' } }));
      await settle();

      expect(client.callsTo(INDEX)).toHaveLength(1);
      expect(client.calls).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('reads nothing without a scope, and reads the new ferret when the ferret changes', async () => {
    const client = clientWith();
    const view = render(providerOf(<SessionSearchControl />, client, { at: null }));
    try {
      await settle();
      expect(client.calls).toEqual([]);
      expect(view.root.findAllByType('input')).toHaveLength(0);

      await runAsync(async () => {
        view.update(providerOf(<SessionSearchControl />, client, { at: SCOPE }));
        await settle();
      });
      expect(client.callsTo(INDEX).map(call => call.params.ferretId)).toEqual([FERRET]);

      const other: FerretSearchScope = { daemon: SCOPE.daemon, ferret: 'ferret-b' };
      await runAsync(async () => {
        view.update(providerOf(<SessionSearchControl />, client, { at: other }));
        await settle();
      });
      expect(client.callsTo(INDEX).map(call => call.params.ferretId)).toEqual([FERRET, 'ferret-b']);
    } finally {
      run(() => view.unmount());
    }
  });
});

/* ---------- the cards ---------------------------------------------------------- */

describe("the ferret's cards", () => {
  const observe = async (
    cards: FerretCardsRead | null,
    client: FakeClient = clientWith(),
  ): Promise<{
    readonly latest: () => Search;
    readonly update: (next: FerretCardsRead) => Promise<void>;
    readonly unmount: () => void;
  }> => {
    let latest: Search | undefined;
    const tree = (read: FerretCardsRead | null) =>
      providerOf(
        <SearchProbe
          onSearch={search => {
            latest = search;
          }}
        />,
        client,
        { cards: read },
      );
    const view = render(tree(cards));
    await settle();
    return {
      latest: () => {
        if (latest === undefined) throw new Error('probe never rendered');
        return latest;
      },
      update: async next => {
        await runAsync(async () => {
          view.update(tree(next));
        });
        await settle();
      },
      unmount: () => run(() => view.unmount()),
    };
  };

  test('lists the cards Board handed in, with their lane names', async () => {
    const probe = await observe(cardsRead([needleCard(), cardOf('F8', { title: 'Assigned to me', lane: 'Plan' })]));
    try {
      const search = probe.latest();
      expect(search.taskState).toBe('ready');
      expect(search.taskError).toBeNull();
      expect(search.tasks.map(task => task.id).sort()).toEqual(['F6', 'F8']);
      expect(search.tasks.find(task => task.id === 'F6')).toMatchObject({ title: 'Needle task', lane: 'Implement' });
    } finally {
      probe.unmount();
    }
  });

  test('says loading until the board answers, then ready, and lets a menu await the one read', async () => {
    const probe = await observe(cardsRead([], 'loading'));
    try {
      expect(probe.latest().taskState).toBe('loading');
      const waiting = probe.latest().waitForTasks();
      expect(waiting).toBeDefined();
      let finished = false;
      void waiting?.then(() => {
        finished = true;
      });
      await settle();
      expect(finished).toBe(false);

      await probe.update(cardsRead());
      expect(probe.latest().taskState).toBe('ready');
      expect(probe.latest().tasks.map(task => task.id)).toEqual(['F6']);
      expect(finished).toBe(true);
      expect(probe.latest().waitForTasks()).toBeUndefined();
    } finally {
      probe.unmount();
    }
  });

  test('says unavailable with the daemon reason when the board cannot be read, and the files stay searchable', async () => {
    const client = clientWith();
    const view = render(
      providerOf(<SessionSearchControl />, client, { cards: cardsRead([], 'unavailable', 'board refused') }),
    );
    try {
      await settle();
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await settle();

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('Cards unavailable');
      expect(drawn).toContain('board refused');
      expect(drawn).not.toContain('Files unavailable');
      expect(drawn).not.toContain('No files or cards of this ferret match');
      expect(view.root.findAll(node => node.props['data-result-kind'] === 'file')).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('is ready with no cards and no error when the host has no board', async () => {
    const probe = await observe(null);
    try {
      expect(probe.latest().taskState).toBe('ready');
      expect(probe.latest().taskError).toBeNull();
      expect(probe.latest().tasks).toEqual([]);
    } finally {
      probe.unmount();
    }
  });

  test('keeps a card from any lane findable', async () => {
    const probe = await observe(cardsRead([needleCard({ lane: 'Done' })]));
    try {
      run(() => probe.latest().setQuery('needle'));
      expect(probe.latest().results.map(sessionSearchResultKey)).toContain('task:F6');
    } finally {
      probe.unmount();
    }
  });
});

/* ---------- coverage and the file half ---------------------------------------- */

describe('honest coverage of the file index', () => {
  const mountControl = async (index: CallHandler = answersIndex(), cards: FerretCardsRead = cardsRead()) => {
    const view = render(providerOf(<SessionSearchControl />, clientWith(index), { cards }));
    await settle();
    return view;
  };

  const rowKinds = (view: ReturnType<typeof render>): readonly string[] =>
    view.root.findAll(node => node.props['data-result-kind'] !== undefined).map(node => node.props['data-result-kind']);

  const type = async (view: ReturnType<typeof render>, value: string): Promise<void> => {
    run(() => view.root.findByType('input').props.onChange({ target: { value } }));
    await settle();
  };

  test('lists a card matched on its summary alone beside the files', async () => {
    const view = await mountControl(
      answersIndex({ files: [] }),
      cardsRead([needleCard({ title: 'Unrelated work', summary: 'The transport layer needs work.' })]),
    );
    try {
      await type(view, 'transport');

      expect(rowKinds(view)).toEqual(['task']);
      expect(JSON.stringify(view.toJSON())).toContain('&F6 · Implement');
    } finally {
      run(() => view.unmount());
    }
  });

  test('keeps a complete index searchable when policy left named paths out of it', async () => {
    const view = await mountControl(
      answersIndex({
        coverage: 'complete',
        skipped: [
          { reason: 'denied', count: 1 },
          { reason: 'excluded', count: 2 },
        ],
      }),
    );
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
    const view = await mountControl(
      answersIndex({ coverage: 'partial', skipped: [{ reason: 'truncated', count: 1 }] }),
    );
    try {
      await type(view, 'needle');

      expect(rowKinds(view)).toContain('file');
      expect(view.root.findByProps({ 'data-search-coverage': '' }).children.join('')).toContain(
        'File results are incomplete: the index did not finish.',
      );
      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).not.toContain('Files unavailable');
      expect(drawn).not.toContain('No files or cards of this ferret match');

      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('qualifies a zero result over a partial index instead of claiming nothing matches', async () => {
    const view = await mountControl(
      answersIndex({
        files: [{ name: 'unrelated.ts', path: 'src/unrelated.ts' }],
        coverage: 'partial',
        skipped: [{ reason: 'unreadable', count: 3 }],
      }),
      cardsRead([]),
    );
    try {
      await type(view, 'needle');

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('No match in the indexed portion of this ferret.');
      expect(drawn).not.toContain('No files or cards of this ferret match');
      expect(view.root.findByProps({ 'data-search-skips': '' }).children.join('')).toContain('3 unreadable');

      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('still makes an unqualified no-match claim when the index really is complete', async () => {
    const view = await mountControl(answersIndex(), cardsRead([]));
    try {
      await type(view, 'absent');

      expect(JSON.stringify(view.toJSON())).toContain('No files or cards of this ferret match');
      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('No results');
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses a query the protocol would reject, at the input', async () => {
    const view = await mountControl();
    try {
      await type(view, 'n'.repeat(MAX_SESSION_SEARCH_QUERY_LENGTH + 1));

      expect(view.root.findAll(node => node.props['data-search-query-invalid'] !== undefined)).toHaveLength(1);
      expect(rowKinds(view)).toEqual([]);
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses an index document that contradicts itself or describes another ferret', async () => {
    for (const broken of [
      fileIndexResponse({ coverage: 'complete', skipped: [{ reason: 'truncated', count: 1 }] }),
      fileIndexResponse({ coverage: 'partial', skipped: [] }),
      { ...fileIndexResponse(), files: [{ name: 'other.ts', path: 'src/needle.ts' }] },
      fileIndexResponse({ sessionId: 'ferret-b' }),
      { entries: [] },
    ]) {
      const view = await mountControl(() => broken);
      try {
        await type(view, 'needle');

        const drawn = JSON.stringify(view.toJSON());
        expect(drawn).toContain('Files unavailable');
        expect(drawn).not.toContain('No files or cards of this ferret match');
      } finally {
        run(() => view.unmount());
      }
    }
  });
});

/* ---------- scope and evidence ------------------------------------------------- */

describe('the published scope and the published evidence never disagree', () => {
  interface Observation {
    readonly daemon: string | undefined;
    readonly taskState: SessionSearchResourceState;
    readonly fileState: SessionSearchResourceState;
    readonly taskIds: readonly string[];
    readonly filePaths: readonly string[];
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
    const activeResult = search.results[search.activeIndex];
    onControl(search);
    onObserve({
      daemon: search.scope?.daemon,
      taskState: search.taskState,
      fileState: search.fileState,
      taskIds: search.tasks.map(task => task.id),
      filePaths: search.files.map(file => file.path),
      query: search.query,
      presenting: search.presenting,
      activeResultKey: activeResult === undefined ? null : sessionSearchResultKey(activeResult),
    });
    return null;
  }

  test('never pairs the new daemon with the previous daemon evidence, not even for one render', async () => {
    const alphaScope: FerretSearchScope = { daemon: 'alpha', ferret: 'shared' };
    const betaScope: FerretSearchScope = { daemon: 'beta', ferret: 'shared' };
    const alpha = clientWith(answersIndex(), 'alpha');
    const beta = clientWith(answersIndex({ files: [] }), 'beta');

    const seen: Observation[] = [];
    let control: SearchController | undefined;
    const observe = (observation: Observation): void => {
      seen.push(observation);
    };
    const captureControl = (current: SearchController): void => {
      control = current;
    };
    const under = (client: FakeClient, at: FerretSearchScope, cards: FerretCardsRead) =>
      providerOf(<ScopeProbe onControl={captureControl} onObserve={observe} />, client, { at, cards });
    const tree = render(under(alpha, alphaScope, cardsRead()));
    try {
      await settle();
      expect(
        seen.some(
          o =>
            o.daemon === 'alpha' &&
            o.taskState === 'ready' &&
            o.taskIds.includes('F6') &&
            o.filePaths.includes('src/needle.ts'),
        ),
      ).toBe(true);

      if (control === undefined) throw new Error('scope probe never published its search controls');
      run(() => {
        control?.setQuery('needle');
        control?.present('scope-probe');
      });
      await settle();
      run(() => control?.setActiveIndex(1));
      expect(seen.at(-1)).toMatchObject({
        query: 'needle',
        presenting: 'scope-probe',
        activeResultKey: 'task:F6',
      });

      const before = seen.length;
      await runAsync(async () => {
        tree.update(under(beta, betaScope, cardsRead([], 'loading')));
        await settle();
      });
      await runAsync(async () => {
        tree.update(under(beta, betaScope, cardsRead([])));
        await settle();
      });

      const onBeta = seen.slice(before).filter(o => o.daemon === 'beta');
      expect(onBeta.length).toBeGreaterThan(0);
      expect(onBeta.filter(o => o.taskIds.includes('F6'))).toEqual([]);
      expect(onBeta.filter(o => o.filePaths.includes('src/needle.ts'))).toEqual([]);
      expect(onBeta[0]?.taskState).toBe('loading');
      expect(onBeta[0]?.fileState).toBe('loading');
      expect(seen.at(-1)).toMatchObject({
        daemon: 'beta',
        taskState: 'ready',
        fileState: 'ready',
        taskIds: [],
        filePaths: [],
        query: '',
        presenting: null,
        activeResultKey: null,
      });
      expect(beta.callsTo(INDEX)).toHaveLength(1);
    } finally {
      run(() => tree.unmount());
    }
  });
});

/* ---------- the control ---------------------------------------------------------- */

describe('current-ferret search control', () => {
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
    {
      index = answersIndex(),
      cards = cardsRead(),
    }: { readonly index?: CallHandler; readonly cards?: FerretCardsRead } = {},
  ) => {
    const client = clientWith(index);
    const view = render(
      providerOf(
        <>
          {openers ? <SearchOpeners onFile={openers.onFile} onTasks={openers.onTasks} /> : null}
          <SessionSearchControl {...props} />
        </>,
        client,
        { cards },
      ),
    );
    await settle();
    return Object.assign(view, { client });
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
    const surface = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
    );
    try {
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
      expect(surface.client.calls).toHaveLength(1);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('caps the presented rows and says exactly how many it is holding back', async () => {
    const view = await mountControl({}, undefined, {
      index: answersIndex({
        files: Array.from({ length: MAX_SESSION_SEARCH_RESULTS + 5 }, (_, index) => ({
          name: `needle-${index}.ts`,
          path: `needle-${index}.ts`,
        })),
      }),
      cards: cardsRead([]),
    });
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
        clientWith(),
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
    const client = clientWith();
    const tree = (signal: number) =>
      providerOf(
        <>
          <SessionSearchControl shortcutTarget />
          <SessionSearchControl />
        </>,
        client,
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
    const view = render(providerOf(<SessionSearchControl shortcutTarget />, clientWith(), { focusSignal: 7 }), {
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
    let releaseIndex: ((answer: unknown) => void) | undefined;
    const opened: string[] = [];
    const view = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
      {
        index: () =>
          new Promise<unknown>(resolve => {
            releaseIndex = resolve;
          }),
      },
    );
    try {
      await search(view, 'needle');
      const taskRow = rows(view)[0];
      expect(taskRow?.props['data-result-kind']).toBe('task');
      run(() => taskRow?.props.onMouseEnter());
      const chosenId = view.root.findByType('input').props['aria-activedescendant'];
      expect(JSON.stringify(view.toJSON())).toContain("Indexing this ferret's files…");
      expect(JSON.stringify(view.toJSON())).not.toContain("Indexing this ferret's cards…");
      await pastAnnounceDebounce();
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');

      await runAsync(async () => {
        releaseIndex?.(fileIndexResponse({ files: [{ name: 'needle.ts', path: 'src/needle.ts' }] }));
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
    const indexing = await mountControl({}, undefined, { index: neverAnswers, cards: cardsRead([], 'loading') });
    try {
      run(() => indexing.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(indexing.toJSON());

      expect(drawn).toContain("Indexing this ferret's files and cards…");
      expect(
        indexing.root.findAll(node => node.type === 'svg' && node.props['data-search-indexing'] !== undefined),
      ).toHaveLength(1);
      expect(indexing.root.findAll(node => node.props['data-search-shortcut'] !== undefined)).toHaveLength(0);
      expect(drawn).not.toContain('No files or cards of this ferret match');
    } finally {
      run(() => indexing.unmount());
    }

    const broken = await mountControl({}, undefined, {
      index: () => ({ entries: [] }),
      cards: cardsRead([], 'unavailable', 'board refused'),
    });
    try {
      run(() => broken.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await settle();
      const drawn = JSON.stringify(broken.toJSON());

      expect(drawn).toContain('Cards unavailable: board refused.');
      expect(drawn).toContain('Files unavailable');
      expect(drawn).not.toContain('No files or cards of this ferret match');
    } finally {
      run(() => broken.unmount());
    }

    const refused = await mountControl({}, undefined, {
      index: () => Promise.reject(new Error('Failed to fetch')),
      cards: cardsRead([], 'unavailable', 'Failed to fetch'),
    });
    try {
      run(() => refused.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      expect(JSON.stringify(refused.toJSON())).toContain(
        'Cards unavailable: Failed to fetch. Files unavailable: Failed to fetch.',
      );
    } finally {
      run(() => refused.unmount());
    }
  });

  test('names only the independently moving half and does not repeat it inside a refusal alert', async () => {
    const cardsMoving = await mountControl({}, undefined, {
      index: answersIndex({ files: [] }),
      cards: cardsRead([], 'loading'),
    });
    try {
      run(() => cardsMoving.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(cardsMoving.toJSON());
      expect(drawn).toContain("Indexing this ferret's cards…");
      expect(drawn).not.toContain("Indexing this ferret's files…");
    } finally {
      run(() => cardsMoving.unmount());
    }

    const failedCards = await mountControl({}, undefined, {
      index: neverAnswers,
      cards: cardsRead([], 'unavailable', 'task read refused'),
    });
    try {
      run(() => failedCards.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(failedCards.toJSON());
      expect(drawn).toContain('Cards unavailable: task read refused.');
      expect(drawn).toContain("Indexing this ferret's files…");
      expect(drawn.match(/Indexing/g)).toHaveLength(1);
      expect(drawn).not.toContain('No files or cards of this ferret match');
    } finally {
      run(() => failedCards.unmount());
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
    const client = clientWith();
    const tree = (signal: number) =>
      providerOf(<SessionSearchControl shortcutTarget />, client, { focusSignal: signal });
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
      expect(JSON.stringify(view.toJSON())).toContain("Type to search this ferret's files and cards.");

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

  test('opening a result only calls the host opener: it asks the daemon for nothing more', async () => {
    const opened: string[] = [];
    const view = await mountControl({}, { onFile: path => opened.push(path), onTasks: () => opened.push('tasks') });
    try {
      await search(view, 'needle');
      run(() => rows(view)[0]?.props.onClick());
      expect(opened).toEqual(['src/needle.ts']);
      expect(view.client.calls).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });
});
