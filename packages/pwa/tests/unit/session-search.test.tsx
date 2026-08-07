import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  FY_REQUEST_ID_HEADER,
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  matchesSessionSearchQuery,
  type ScopedTaskSummary,
  type SessionFileIndexCoverage,
  type SessionFileIndexEntry,
  type SessionFileIndexSkip,
  type SessionSearchTask,
  sessionSearchTaskHaystack,
} from '@ferretry/protocol';
import { useEffect } from 'react';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import {
  filterSessionSearchResults,
  MAX_SESSION_SEARCH_RESULTS,
  SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
  SESSION_SEARCH_QUERY_DEBOUNCE_MS,
  SessionSearchControl,
  SessionSearchProvider,
  type SessionSearchResourceState,
  SessionTasksSearchSurface,
  sessionSearchResultKey,
  useSessionSearch,
} from '../../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../../src/shell/palette-shortcut.ts';
import { render, run, runAsync } from '../support/react.ts';
import { type TaskSummaryOverrides, taskSummary } from '../support/tasks.ts';

const daemon = daemonConnection({
  daemonId: 'search-daemon',
  baseUrl: 'https://search.example.test',
  deviceToken: 'search-token',
});
const scope = daemonSessionScope(daemon, 'session-a');
const originalFetch = globalThis.fetch;
const composers: Array<() => void> = [];

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

/**
 * Waits past the query debounce, which `settle()` alone cannot do.
 *
 * `settle` turns microtasks; the debounced `?q=` read is armed with a real
 * `setTimeout`, so a test that only settles observes the SEARCHING state
 * forever and would conclude the task half is empty. Every assertion about a
 * settled query has to cross a real task boundary first.
 */
const afterQuerySettles = async (): Promise<void> => {
  await runAsync(async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_QUERY_DEBOUNCE_MS + 20)));
  await settle();
};

/* ---------- protocol-shaped fixtures -------------------------------------- */

/**
 * One board row as the DAEMON holds it: the summary it puts on the wire, and the
 * prose only it can match `?q=` against.
 *
 * The two halves are deliberately separate records. `ScopedTaskSummarySchema` is
 * non-strict, so a fixture that put `description`/`ask`/`clarifications` on the
 * summary would have them silently stripped and would keep passing while proving
 * nothing about prose — the false green called out in the integration design.
 * Keeping the prose in its own record forces every `?q=` answer to come from
 * `matchesSessionSearchQuery`, which is the daemon's own predicate.
 */
interface BoardTask {
  readonly summary: ScopedTaskSummary;
  readonly prose: SessionSearchTask;
}

const boardTask = (
  overrides: TaskSummaryOverrides = {},
  prose: {
    readonly description?: string;
    readonly ask?: string;
    readonly clarifications?: readonly string[];
  } = {},
  sessionId: string | null = 'session-a',
): BoardTask => {
  const description = prose.description ?? '';
  const ask = prose.ask ?? '';
  const clarifications = prose.clarifications ?? [];
  const summary: ScopedTaskSummary = {
    ...taskSummary({
      id: 'F6',
      title: 'Needle task',
      ...overrides,
      // Counts describe the prose the summary does NOT carry, so they are derived
      // from it rather than restated — a summary claiming zero description chars
      // beside a matching description is a fixture that cannot happen on the wire.
      descriptionChars: description.length,
      askChars: ask.length,
      clarificationCount: clarifications.length,
    }),
    sessionId,
  };
  return {
    summary,
    prose: {
      id: summary.id,
      title: summary.title,
      description,
      ask: { text: ask },
      clarifications: clarifications.map(text => ({ text })),
    },
  };
};

/** The default board: one task findable by title, and by three kinds of prose. */
const needleTask = (overrides: TaskSummaryOverrides = {}): BoardTask =>
  boardTask(
    { id: 'F6', title: 'Needle task', ...overrides },
    {
      description: 'Search the current session quickly.',
      ask: 'Find the task I half remember',
      clarifications: ['Include original asks and every clarification.'],
    },
  );

/** A board of `count` rows, none of which matches `needle` or `port`. */
const board = (count: number): readonly BoardTask[] =>
  Array.from({ length: count }, (_, index) => boardTask({ id: `F${index + 1}`, title: `Board row ${index + 1}` }));

/**
 * A FLAT index over a tree of `directories` directories.
 *
 * The shape is the point: the daemon walked the tree, so the browser receives
 * one document no matter how deep it was. `directories` exists only so the
 * request-count regressions can say what the old browser-side crawl would have
 * cost — the index itself has no notion of one.
 */
const indexEntries = (directories: number, perDirectory = 2): readonly SessionFileIndexEntry[] =>
  Array.from({ length: directories }, (_, directory) =>
    Array.from({ length: perDirectory }, (_, file) => ({
      name: `row-${directory}-${file}.ts`,
      path: `dir-${directory}/row-${directory}-${file}.ts`,
    })),
  ).flat();

const NEEDLE_FILES: readonly SessionFileIndexEntry[] = [
  { name: 'needle.ts', path: 'src/needle.ts' },
  { name: 'README.md', path: 'README.md' },
];

const taskListResponse = (
  rows: readonly BoardTask[],
  { sessionId = 'session-a', parseErrors = 0 }: { readonly sessionId?: string; readonly parseErrors?: number } = {},
) => ({
  v: 1,
  sessionId,
  tasks: rows.map(row => row.summary),
  parseErrors,
  updatedAt: '2026-08-06T00:00:00.000Z',
});

const fileIndexResponse = ({
  files = NEEDLE_FILES,
  coverage = 'complete',
  skipped = [],
  sessionId = 'session-a',
}: {
  readonly files?: readonly SessionFileIndexEntry[];
  readonly coverage?: SessionFileIndexCoverage;
  readonly skipped?: readonly SessionFileIndexSkip[];
  readonly sessionId?: string;
} = {}) => ({ v: 1, sessionId, root: `/work/${sessionId}`, files, coverage, skipped });

/* ---------- the request ledger -------------------------------------------- */

interface Recorded {
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
}

const bareTaskReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.method === 'GET' && row.pathname.endsWith('/tasks') && !row.search.has('q'));
const queryTaskReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.method === 'GET' && row.pathname.endsWith('/tasks') && row.search.has('q'));
/** The N+1 fan-out this row deleted. A POST to the same path is Mark Done, not a read. */
const taskDetailReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.method === 'GET' && /\/tasks\/[^/]+$/u.test(row.pathname));
const indexReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.pathname.endsWith('/fs/index'));
/** The browser-side breadth-first crawl this row deleted. */
const listingReads = (seen: readonly Recorded[]): readonly Recorded[] =>
  seen.filter(row => row.pathname.endsWith('/fs'));

interface RoutesOptions {
  readonly tasks?: readonly BoardTask[];
  readonly parseErrors?: number;
  readonly taskSessionId?: string;
  readonly index?: ReturnType<typeof fileIndexResponse> | Record<string, unknown>;
}

/**
 * The daemon as this row leaves it: a summary board, a server-side `?q=`, and one
 * versioned index document.
 *
 * THE LADDER ORDER IS LOAD-BEARING. `/fs/index` does not end with `/fs`, so a
 * ladder that tests `/fs` first answers the index with a directory listing and
 * every card silently reads `unavailable`. The dead routes answer 410 rather than
 * falling through to a 404, so an accidental dial is named in the failure rather
 * than looking like an ordinary miss.
 */
const searchRoutes = (options: RoutesOptions = {}) => {
  const rows = options.tasks ?? [needleTask()];
  const seen: Recorded[] = [];
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push({ method, pathname: url.pathname, search: url.searchParams });
    if (url.pathname.endsWith('/fs/index')) return Response.json(options.index ?? fileIndexResponse());
    if (url.pathname.endsWith('/fs')) return new Response('the browser-side file crawl is gone', { status: 410 });
    if (method === 'GET' && /\/tasks\/[^/]+$/u.test(url.pathname))
      return new Response('per-task detail reads are gone', { status: 410 });
    if (url.pathname.endsWith('/tasks')) {
      const query = url.searchParams.get('q');
      // The DAEMON decides membership, over prose the summary does not carry.
      const answered =
        query === null
          ? rows
          : rows.filter(row => matchesSessionSearchQuery(sessionSearchTaskHaystack(row.prose), query));
      return Response.json(
        taskListResponse(answered, {
          ...(options.taskSessionId === undefined ? {} : { sessionId: options.taskSessionId }),
          ...(options.parseErrors === undefined ? {} : { parseErrors: options.parseErrors }),
        }),
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { seen, handler };
};

const install = (options: RoutesOptions = {}): readonly Recorded[] => {
  const { seen, handler } = searchRoutes(options);
  globalThis.fetch = handler;
  return seen;
};

function SearchOpeners({ onFile, onTasks }: { readonly onFile: (path: string) => void; readonly onTasks: () => void }) {
  const search = useSessionSearch();
  useEffect(() => {
    search.setOpeners({ openFile: onFile, openTasks: onTasks });
    return () => search.setOpeners(null);
  }, [onFile, onTasks, search]);
  return null;
}

function TaskWaitProbe({ onReady }: { readonly onReady: (wait: () => Promise<void> | undefined) => void }) {
  onReady(useSessionSearch().waitForTasks);
  return null;
}

beforeEach(() => {
  install();
});

/** A composer registered under one exact scope, so a delivery can be observed. */
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

/**
 * The model, on the shapes the daemon actually sends.
 *
 * `filterSessionSearchResults` is deliberately ASYMMETRIC now and these tests are
 * what says so: tasks arrive already matched by the daemon over prose the browser
 * never sees, so they pass through; files are matched here, against the index,
 * with the protocol's own matcher.
 */
describe('current-session search model', () => {
  test('passes daemon-confirmed tasks through without re-deciding membership', () => {
    // Nothing about this row contains "port" in any field the BROWSER can see —
    // the daemon matched it on its original ask. A model that re-checked locally
    // would drop it, which is the whole defect the server-side matcher removes.
    const proseOnly = boardTask({ id: 'F12', title: 'Unrelated work' }, { ask: 'Finish porting the PWA feature' });
    const result = filterSessionSearchResults([proseOnly.summary], [], 'port');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'task', task: { id: 'F12' } });
  });

  test('matches file names and full paths with the protocol matcher, case-insensitively', () => {
    const files: readonly SessionFileIndexEntry[] = [
      { name: 'SessionSearch.tsx', path: 'packages/pwa/src/session/SessionSearch.tsx' },
    ];

    expect(filterSessionSearchResults([], files, 'sessionsearch')).toHaveLength(1);
    expect(filterSessionSearchResults([], files, 'packages/pwa')).toHaveLength(1);
    // A file the query does not name is not a member, however many tasks matched.
    expect(filterSessionSearchResults([], files, 'absent')).toHaveLength(0);
  });

  test('does not invent results for a blank query', () => {
    expect(filterSessionSearchResults([needleTask().summary], NEEDLE_FILES, '   ')).toEqual([]);
  });

  test('ranks a file matching name and path above a task matching only its title', () => {
    const ranked = filterSessionSearchResults(
      [needleTask().summary],
      [{ name: 'needle.ts', path: 'src/needle.ts' }],
      'needle',
    );

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({ kind: 'file', path: 'src/needle.ts' });
    expect(ranked[1]).toMatchObject({ kind: 'task' });
  });

  /**
   * THE CONFIRMED-MATCH FLOOR, pinned from BOTH sides.
   *
   * A summary carries no description, ask or clarification, so a task the daemon
   * matched on prose alone scores zero on every field the browser can rank — and
   * a zero-scored member parks behind every file. The floor exists because the
   * daemon already PROVED the row matches; it is not a guess the browser is
   * hedging.
   *
   * Two files fence it. A floor set too low sinks the task behind a file matched
   * only somewhere in its path; a floor set too high lifts it over a file matched
   * by its own name, which breaks the rule the weights table exists to state — a
   * name outranks a path, and prose ranks below both.
   */
  test('floors a daemon-confirmed prose-only task above a path-only file and below a named one', () => {
    const proseOnly = boardTask({ id: 'F12', title: 'Unrelated work' }, { ask: 'Finish porting the PWA feature' });
    const ranked = filterSessionSearchResults(
      [proseOnly.summary],
      [
        // Matched only deep inside its path.
        { name: 'helpers.ts', path: 'src/transport/helpers.ts' },
        // Matched in its own name.
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
      [boardTask({ id: 'F7', title: 'Needle task' }).summary, boardTask({ id: 'F8', title: 'Needle task' }).summary],
      [],
      'needle',
    );

    expect(ranked.map(sessionSearchResultKey)).toEqual(['task:F7', 'task:F8']);
  });
});

/**
 * THE REQUEST LEDGER — the measurable deliverable of this row.
 *
 * Before this change one mount cost `N + D + 2` requests: a board list, one
 * detail read per task, and a serial breadth-first walk of the session tree. Both
 * fan-outs are gone, and "gone" is a number rather than a description.
 */
describe('what one mounted session scope costs', () => {
  const mountProvider = async (seenOptions: RoutesOptions) => {
    const seen = install(seenOptions);
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    await settle();
    return { seen, view };
  };

  test('counts every request one session mount makes, and it is two', async () => {
    // N = 12 tasks, D = 6 directories — the fixture the integration design fixes
    // the before/after arithmetic to. Before: 1 + 12 detail reads + 7 listings.
    const { seen, view } = await mountProvider({
      tasks: board(12),
      index: fileIndexResponse({ files: indexEntries(6) }),
    });
    try {
      expect(bareTaskReads(seen)).toHaveLength(1);
      expect(indexReads(seen)).toHaveLength(1);
      expect(taskDetailReads(seen)).toHaveLength(0);
      expect(listingReads(seen)).toHaveLength(0);
      expect(seen).toHaveLength(2);
    } finally {
      run(() => view.unmount());
    }
  });

  test('is independent of board size and tree depth', async () => {
    // N = 40, D = 25. Before: 1 + 40 + 26 = 67 requests. The point of the index
    // is that this number cannot move with the session's shape.
    const { seen, view } = await mountProvider({
      tasks: board(40),
      index: fileIndexResponse({ files: indexEntries(25) }),
    });
    try {
      expect(seen).toHaveLength(2);
      expect(taskDetailReads(seen)).toHaveLength(0);
      expect(listingReads(seen)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends one request on a settled query and none on the keystrokes inside it', async () => {
    const { seen, view } = await mountProvider({ tasks: [needleTask()] });
    try {
      const input = view.root.findByType('input');
      for (const value of ['p', 'po', 'por', 'port']) run(() => input.props.onChange({ target: { value } }));
      // Four keystrokes inside one debounce window are one question.
      expect(queryTaskReads(seen)).toHaveLength(0);

      await afterQuerySettles();

      const queries = queryTaskReads(seen);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.search.get('q')).toBe('port');
      // Still exactly the two mount reads beside it, and neither fan-out is back.
      expect(bareTaskReads(seen)).toHaveLength(1);
      expect(indexReads(seen)).toHaveLength(1);
      expect(taskDetailReads(seen)).toHaveLength(0);
      expect(listingReads(seen)).toHaveLength(0);
      expect(seen).toHaveLength(3);
    } finally {
      run(() => view.unmount());
    }
  });

  test('encodes a query the wire would otherwise mangle', async () => {
    // `URLSearchParams`, never `encodeURIComponent`: the daemon parses with
    // `URLSearchParams` semantics, where a raw `+` decodes to a space. A reader
    // searching `a+b` would otherwise be silently answered about `a b`.
    const { seen, view } = await mountProvider({ tasks: [needleTask()] });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'a+b' } }));
      await afterQuerySettles();

      expect(queryTaskReads(seen)).toHaveLength(1);
      expect(queryTaskReads(seen)[0]?.search.get('q')).toBe('a+b');
    } finally {
      run(() => view.unmount());
    }
  });

  /**
   * THE WIRE CARRIES THE NORMALIZED FORM, not what the reader's fingers produced.
   *
   * `normalizeSessionSearchQuery` is trim-then-case-fold, and it is the protocol's
   * so that the daemon's matching and any client's highlighting are decided on
   * the same text. Sending the raw string instead would spend a separate request
   * for `PoRt`, `port` and `  port  ` — three cache keys and three answers for
   * one question — and would make the keyed snapshot's identity the reader's
   * whitespace.
   */
  test('sends the normalized query, so padding and case are not three different questions', async () => {
    const { seen, view } = await mountProvider({ tasks: [needleTask()] });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: '  PoRt  ' } }));
      await afterQuerySettles();

      const queries = queryTaskReads(seen);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.search.get('q')).toBe('port');
      // The box still shows exactly what was typed: normalization is a wire
      // concern, and rewriting the reader's text under their cursor is not.
      expect(view.root.findByType('input').props.value).toBe('  PoRt  ');

      // And the same question asked a second way earns no second request.
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'PORT' } }));
      await afterQuerySettles();
      expect(queryTaskReads(seen)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('keeps a failed normalized query unavailable when only its raw spelling changes', async () => {
    const seen: Recorded[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse());
      if (url.pathname.endsWith('/tasks') && url.searchParams.has('q'))
        return new Response('too busy', { status: 503 });
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse([needleTask()]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(queryTaskReads(seen)).toHaveLength(1);
      expect(JSON.stringify(view.toJSON())).toContain('Task search unavailable');

      // Both edits are the same trim-and-folded identity. They update what the
      // reader sees, but neither earns another request nor erases the standing
      // refusal with a searching state no effect is armed to settle.
      for (const value of ['needle ', 'NEEDLE']) {
        run(() => input.props.onChange({ target: { value } }));
        await afterQuerySettles();
      }

      const drawn = JSON.stringify(view.toJSON());
      expect(input.props.value).toBe('NEEDLE');
      expect(queryTaskReads(seen)).toHaveLength(1);
      expect(drawn).toContain('Task search unavailable');
      expect(drawn).toContain('HTTP 503');
      expect(drawn).not.toContain("Searching this session's tasks");
      expect(view.root.findAll(node => node.props['data-search-searching'] !== undefined)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses a query the daemon would reject, at the input, instead of spending a 400', async () => {
    const { seen, view } = await mountProvider({ tasks: [needleTask()] });
    const invalid = view.root.findByType('input');
    try {
      run(() => invalid.props.onChange({ target: { value: 'x'.repeat(MAX_SESSION_SEARCH_QUERY_LENGTH + 1) } }));
      await afterQuerySettles();

      expect(queryTaskReads(seen)).toHaveLength(0);
      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('Search text must be between 1 and 200 characters without control characters.');
      expect(view.root.findAll(node => node.props['data-search-query-invalid'] !== undefined).length).toBeGreaterThan(
        0,
      );
      // A refused query is NOT a failed daemon and NOT a genuine empty answer.
      expect(drawn).not.toContain('Tasks unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');

      // A control character is refused on the same terms, and still spends
      // nothing. A REAL one: the string 'a control character' is a perfectly
      // valid query, so a fixture that only DESCRIBED one would be refused for
      // nothing and this assertion would pass for the wrong reason.
      // Built rather than typed, so no invisible byte sits in this source file.
      run(() => invalid.props.onChange({ target: { value: `need${String.fromCodePoint(7)}le` } }));
      await afterQuerySettles();
      expect(queryTaskReads(seen)).toHaveLength(0);
      expect(JSON.stringify(view.toJSON())).toContain('Search text must be between 1 and 200 characters');

      // Blank is not a refusal — it is a question nobody asked yet.
      run(() => invalid.props.onChange({ target: { value: '   ' } }));
      await afterQuerySettles();
      expect(queryTaskReads(seen)).toHaveLength(0);
      const blank = JSON.stringify(view.toJSON());
      expect(blank).not.toContain('Search text must be between 1 and 200 characters');
      expect(blank).toContain("Type to search this session's files and tasks.");
    } finally {
      run(() => view.unmount());
    }
  });

  test('names the settling query without flashing an empty task half', async () => {
    const { seen, view } = await mountProvider({ tasks: [needleTask()] });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      const settling = JSON.stringify(view.toJSON());
      // "Searching", not "Indexing": the mount reads finished long ago and telling
      // the reader the index is still building would name the wrong activity.
      expect(settling).toContain("Searching this session's tasks…");
      expect(settling).not.toContain("Indexing this session's");
      expect(settling).not.toContain('No current-session files or tasks match');
      // The file half is local, so it answers immediately rather than waiting.
      expect(view.root.findAll(node => node.props['data-result-kind'] === 'file')).toHaveLength(1);

      await afterQuerySettles();

      const settled = JSON.stringify(view.toJSON());
      expect(settled).not.toContain("Searching this session's tasks…");
      expect(queryTaskReads(seen)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('reads the parse errors the list response carries', async () => {
    // The field exists on the wire today and nothing reads it: rows the daemon
    // could not parse are simply absent, which is indistinguishable from a board
    // that does not have them.
    const { view } = await mountProvider({ tasks: [needleTask()], parseErrors: 2 });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(view.root.findByProps({ 'data-search-parse-errors': '' }).children.join('')).toContain(
        '2 tasks could not be read.',
      );
    } finally {
      run(() => view.unmount());
    }
  });
});

/**
 * WHAT THE DAEMON MATCHED, and what the popup is allowed to claim about coverage.
 */
describe('server-decided membership and honest coverage', () => {
  const mountControl = async (options: RoutesOptions = {}) => {
    const seen = install(options);
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    await settle();
    return { seen, view };
  };

  const rowKinds = (view: ReturnType<typeof render>): readonly string[] =>
    view.root.findAll(node => node.props['data-result-kind'] !== undefined).map(node => node.props['data-result-kind']);

  test('lists a task the daemon matched on description, on the ask, or on a clarification alone', async () => {
    // Each field carries "port" and NOTHING the browser can see does: the title
    // is `Unrelated work` and the id is `F12`. A row that appears therefore
    // appeared because the daemon said so, which is the whole point of moving
    // the predicate off the client.
    const listed: string[] = [];
    for (const [field, prose] of [
      ['description', { description: 'The transport layer needs work.' }],
      ['ask', { ask: 'Finish porting the PWA feature components' }],
      ['clarification', { clarifications: ['Only the reporting screens.'] }],
    ] as const) {
      const row = boardTask({ id: 'F12', title: 'Unrelated work' }, prose);
      const { view } = await mountControl({ tasks: [row], index: fileIndexResponse({ files: [] }) });
      try {
        run(() => view.root.findByType('input').props.onChange({ target: { value: 'port' } }));
        await afterQuerySettles();

        if (rowKinds(view).join(',') === 'task' && JSON.stringify(view.toJSON()).includes('Unrelated work'))
          listed.push(field);
      } finally {
        run(() => view.unmount());
      }
    }

    // Collected rather than asserted in the loop so a failure names WHICH prose
    // field stopped being searchable, instead of only the first one that broke.
    expect(listed).toEqual(['description', 'ask', 'clarification']);
  });

  /**
   * THE POPUP RENDERS THE QUERY RESPONSE, and that is why it is not the pane.
   *
   * The two task surfaces read different sources on purpose: the pane projects
   * matched ids onto the stable mount board, because that is what every action
   * and every reference proof operates on, while the popup lists the rows the
   * daemon just answered with. Unifying them by projecting popup rows onto the
   * mount board looks like a tidy-up and silently costs two things — a task
   * created AFTER the mount read would vanish from search entirely, and a
   * renamed task would be listed and ranked under its stale title.
   *
   * This pins the first, which is the one nothing else in the suite would
   * notice: the board here never contained `F9` at all.
   */
  test('lists a task created after the mount read, which the board cannot know about', async () => {
    const fresh = boardTask({ id: 'F9', title: 'Fresh needle task' }, { ask: 'find the needle' });
    const seen: Recorded[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse({ files: [] }));
      // The board read answers an EMPTY session; only the narrowing knows F9.
      if (url.pathname.endsWith('/tasks'))
        return Response.json(taskListResponse(url.searchParams.has('q') ? [fresh] : []));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const popup = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => popup.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(rowKinds(popup)).toEqual(['task']);
      expect(JSON.stringify(popup.toJSON())).toContain('Fresh needle task');
      // Still one narrowing request, and still no detail read to "confirm" a row
      // the board has never seen.
      expect(queryTaskReads(seen)).toHaveLength(1);
      expect(taskDetailReads(seen)).toHaveLength(0);
    } finally {
      run(() => popup.unmount());
    }
  });

  test('keeps a complete index searchable when policy left named paths out of it', async () => {
    // `denied`, `excluded` and `unsupported` are policy omissions, not a walk that
    // stopped: the index is still the whole searchable set. Before this row, one
    // denied directory threw and erased every file in the session.
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
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(rowKinds(view)).toContain('file');
      expect(view.root.findByProps({ 'data-search-skips': '' }).children.join('')).toContain(
        'Not indexed: 1 denied, 2 excluded.',
      );
      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).not.toContain('Files unavailable');
      // A complete index is complete. Only an unreadable or truncated subtree
      // makes it partial, and neither happened here.
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
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(rowKinds(view)).toContain('file');
      expect(view.root.findByProps({ 'data-search-coverage': '' }).children.join('')).toContain(
        'File results are incomplete: the index did not finish.',
      );
      const drawn = JSON.stringify(view.toJSON());
      // Ready-but-incomplete is neither unavailable nor an empty answer.
      expect(drawn).not.toContain('Files unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');

      await runAsync(
        async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
      );
      // A partial index cannot honestly announce a count — not even zero.
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('qualifies a zero result over a partial index instead of claiming nothing matches', async () => {
    const { view } = await mountControl({
      tasks: [],
      index: fileIndexResponse({
        files: [{ name: 'unrelated.ts', path: 'src/unrelated.ts' }],
        coverage: 'partial',
        skipped: [{ reason: 'unreadable', count: 3 }],
      }),
    });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('No match in the indexed portion of this session.');
      // THE UNCONDITIONAL SENTENCE IS A LIE HERE. Part of the tree was never read,
      // so "no current-session files or tasks match" claims knowledge the daemon
      // explicitly said it does not have.
      expect(drawn).not.toContain('No current-session files or tasks match');
      expect(view.root.findByProps({ 'data-search-skips': '' }).children.join('')).toContain('3 unreadable');

      await runAsync(
        async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
      );
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');
    } finally {
      run(() => view.unmount());
    }
  });

  test('still makes an unqualified no-match claim when the index really is complete', async () => {
    const { view } = await mountControl({ tasks: [], index: fileIndexResponse({ files: [] }) });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('No current-session files or tasks match');
      expect(drawn).not.toContain('No match in the indexed portion');

      await runAsync(
        async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
      );
      // A complete index that found nothing CAN announce it.
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('No results');
    } finally {
      run(() => view.unmount());
    }
  });

  test('refuses an index document that contradicts itself or describes another session', async () => {
    for (const broken of [
      // Complete beside a truncated skip: the refinement the protocol owns.
      fileIndexResponse({ coverage: 'complete', skipped: [{ reason: 'truncated', count: 1 }] }),
      // Partial with nothing to blame it on.
      fileIndexResponse({ coverage: 'partial', skipped: [] }),
      // A name that is not its path's basename.
      { ...fileIndexResponse(), files: [{ name: 'other.ts', path: 'src/needle.ts' }] },
      // The wrong session entirely — the scope guard, on the new reader.
      fileIndexResponse({ sessionId: 'session-b' }),
      // Not an index document at all: what a `/fs` listing would answer.
      { entries: [] },
    ]) {
      const { view } = await mountControl({ index: broken });
      try {
        run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
        await afterQuerySettles();

        const drawn = JSON.stringify(view.toJSON());
        expect(drawn).toContain('Files unavailable');
        // An unavailable index is never dressed up as an empty result.
        expect(drawn).not.toContain('No current-session files or tasks match');
      } finally {
        run(() => view.unmount());
      }
    }
  });

  test('refuses a task list from another session', async () => {
    const { view } = await mountControl({ taskSessionId: 'session-b' });
    try {
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(JSON.stringify(view.toJSON())).toContain('Tasks unavailable');
    } finally {
      run(() => view.unmount());
    }
  });

  test('keeps the file half searchable when only the query read fails', async () => {
    const seen: Recorded[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse());
      if (url.pathname.endsWith('/tasks') && url.searchParams.has('q'))
        return new Response('too busy', { status: 503 });
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse([needleTask()]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      const drawn = JSON.stringify(view.toJSON());
      // A FAILED SEARCH IS NOT A FAILED INDEX. The board and the file index both
      // read cleanly; only the narrowing did not, so the file rows still open.
      expect(drawn).toContain('Task search unavailable');
      expect(drawn).not.toContain('Tasks unavailable.');
      expect(drawn).not.toContain('Files unavailable');
      expect(view.root.findAll(node => node.props['data-result-kind'] === 'file')).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });
});

/**
 * A LATE ANSWER MAY NEVER OVERWRITE A NEWER QUESTION.
 *
 * The query reader is a brand-new network path, so the fencing #321 established
 * for the mount reads has to be re-established for it: an answer is filed under
 * the daemon, session AND normalized query that ASKED it.
 */
describe('the query reader is fenced by scope and by query', () => {
  /**
   * A PENDING QUERY SHOWS NO TASK ROWS FROM THE PREVIOUS ONE.
   *
   * Keeping the last answer on screen while a new one is in flight reads as
   * "these rows match what you have typed", and they do not — the reader typed
   * something else. Two keystrokes later they would click a row that answers a
   * question they have already abandoned. The file half is different and stays:
   * it is matched locally against an index already in hand, so it is a current
   * answer rather than a stale one.
   */
  test('drops the previous query’s task rows the moment a newer query is pending', async () => {
    const pending = new Map<string, (response: Response) => void>();
    const alphaRow = boardTask({ id: 'F1', title: 'Alpha row' }, { ask: 'about alpha' });
    const betaRow = boardTask({ id: 'F2', title: 'Beta row' }, { ask: 'about beta' });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      // Matches BOTH queries, so it can prove the file half survives the switch.
      if (url.pathname.endsWith('/fs/index'))
        return Response.json(fileIndexResponse({ files: [{ name: 'alpha-beta.ts', path: 'src/alpha-beta.ts' }] }));
      const query = url.searchParams.get('q');
      if (url.pathname.endsWith('/tasks') && query !== null)
        return await new Promise<Response>(resolve => pending.set(query, resolve));
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse([alphaRow, betaRow]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'alpha' } }));
      await afterQuerySettles();
      await runAsync(async () => {
        pending.get('alpha')?.(Response.json(taskListResponse([alphaRow])));
        await settle();
      });
      expect(JSON.stringify(view.toJSON())).toContain('Alpha row');

      // The very next render after the keystroke, with beta still in flight.
      run(() => input.props.onChange({ target: { value: 'beta' } }));
      const whilePending = JSON.stringify(view.toJSON());
      expect(whilePending).not.toContain('Alpha row');
      expect(whilePending).toContain("Searching this session's tasks…");
      // The local half is a current answer, so it is still shown.
      expect(view.root.findAll(node => node.props['data-result-kind'] === 'file')).toHaveLength(1);
      // A pending query is not a no-match answer either.
      expect(whilePending).not.toContain('No current-session files or tasks match');

      await afterQuerySettles();
      await runAsync(async () => {
        pending.get('beta')?.(Response.json(taskListResponse([betaRow])));
        await settle();
      });

      const settled = JSON.stringify(view.toJSON());
      expect(settled).toContain('Beta row');
      expect(settled).not.toContain('Alpha row');
    } finally {
      run(() => view.unmount());
    }
  });

  test('cannot let a slow first query replace the answer to a newer one', async () => {
    const pending = new Map<string, (response: Response) => void>();
    const rows = [
      boardTask({ id: 'F1', title: 'Alpha row' }, { ask: 'about alpha' }),
      boardTask({ id: 'F2', title: 'Beta row' }, { ask: 'about beta' }),
    ];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse({ files: [] }));
      const query = url.searchParams.get('q');
      if (url.pathname.endsWith('/tasks') && query !== null)
        return await new Promise<Response>(resolve => pending.set(query, resolve));
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse(rows));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'alpha' } }));
      await afterQuerySettles();
      run(() => input.props.onChange({ target: { value: 'beta' } }));
      await afterQuerySettles();
      expect([...pending.keys()]).toEqual(['alpha', 'beta']);

      // The NEWER answer lands first, then the stale one arrives behind it.
      await runAsync(async () => {
        pending.get('beta')?.(Response.json(taskListResponse([rows[1] as BoardTask])));
        await settle();
      });
      expect(JSON.stringify(view.toJSON())).toContain('Beta row');

      await runAsync(async () => {
        pending.get('alpha')?.(Response.json(taskListResponse([rows[0] as BoardTask])));
        await settle();
      });

      const drawn = JSON.stringify(view.toJSON());
      expect(drawn).toContain('Beta row');
      // The reader is looking at "beta". An answer about "alpha" arriving late is
      // an answer to a question they have already moved on from.
      expect(drawn).not.toContain('Alpha row');
    } finally {
      run(() => view.unmount());
    }
  });

  test('publishes a query that settles after a scope change under the scope that started it', async () => {
    const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.test', deviceToken: 'a' });
    const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.test', deviceToken: 'b' });
    const alphaScope = daemonSessionScope(alpha, 'shared');
    const betaScope = daemonSessionScope(beta, 'shared');
    const alphaRow = boardTask({ id: 'F1', title: 'Alpha only' }, { ask: 'needle' }, 'shared');
    let releaseAlphaQuery: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index'))
        return Response.json(fileIndexResponse({ files: [], sessionId: 'shared' }));
      const query = url.searchParams.get('q');
      if (url.pathname.endsWith('/tasks') && query !== null && url.host === 'alpha.test')
        return await new Promise<Response>(resolve => {
          releaseAlphaQuery = resolve;
        });
      if (url.pathname.endsWith('/tasks'))
        return Response.json(taskListResponse(url.host === 'alpha.test' ? [alphaRow] : [], { sessionId: 'shared' }));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = render(
      <SessionSearchProvider connection={alpha} focusSignal={0} scope={alphaScope}>
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => view.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();
      expect(releaseAlphaQuery).toBeDefined();

      await runAsync(async () => {
        view.update(
          <SessionSearchProvider connection={beta} focusSignal={0} scope={betaScope}>
            <SessionSearchControl />
          </SessionSearchProvider>,
        );
        await settle();
      });
      // A scope change closes the question: the shared query is cleared with it.
      expect(view.root.findByType('input').props.value).toBe('');

      await runAsync(async () => {
        releaseAlphaQuery?.(Response.json(taskListResponse([alphaRow], { sessionId: 'shared' })));
        await settle();
      });

      // Alpha's answer may not appear on beta, whose board has no such task.
      expect(JSON.stringify(view.toJSON())).not.toContain('Alpha only');
    } finally {
      run(() => view.unmount());
    }
  });
});

describe('the Tasks surface acts on summaries', () => {
  const liveTask = (): BoardTask => needleTask({ phase: 'live', status: 'live' });

  /** The full view a completion POST answers with — never what the board holds. */
  const confirmedView = (statusReason: string): Record<string, unknown> => ({
    ...liveTask().summary,
    phase: 'done',
    status: 'done',
    statusReason,
    description: 'Search the current session quickly.',
    ask: { text: 'Find the task I half remember', source: 'human-message' },
    clarifications: [],
    sessionId: 'session-a',
  });

  /**
   * THE PANE FILTERS THE MOUNT BOARD BY MATCHED ID. It does not render the
   * query response's own rows.
   *
   * Both payloads are `ScopedTaskSummary`, so rendering the wrong one looks
   * identical until the two disagree — and they do the moment anything overlays
   * the board. An optimistic Mark Done lives on the MOUNT snapshot; a pane fed
   * from the query response would drop that overlay on the next keystroke and
   * show the task live again while the POST was still in flight. For the PANE,
   * the narrowing response's job is to say WHICH ids matched; the popup below
   * deliberately renders the query-time summary itself.
   *
   * The fixture makes the two sources disagree on purpose: the query answers
   * with the same id under a title the board has never carried.
   */
  test('keeps query summaries in the popup while filtering pane rows from the mounted board', async () => {
    const stable = needleTask({ id: 'F6', title: 'Needle task' });
    const other = boardTask({ id: 'F7', title: 'Unrelated row' });
    const impostor = { ...stable.summary, title: 'Query payload title' };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse({ files: [] }));
      if (url.pathname.endsWith('/tasks') && url.searchParams.has('q'))
        return Response.json({
          v: 1,
          sessionId: 'session-a',
          tasks: [impostor],
          parseErrors: 0,
          updatedAt: '2026-08-06T00:00:00.000Z',
        });
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse([stable, other]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => surface.root.findByType('input').props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      // Narrowed to the matched id…
      expect(surface.root.findAllByProps({ 'data-task-id': 'F6' }).length).toBeGreaterThan(0);
      expect(surface.root.findAllByProps({ 'data-task-id': 'F7' })).toHaveLength(0);

      // …and every pane row is rendered from the BOARD. `data-task-title` is the
      // pane's own row marker, so this reads the pane alone rather than the whole
      // surface: the popup is a separate presentation of the query response and
      // is deliberately not what this test is about.
      const paneTitles = surface.root
        .findAll(node => node.props['data-task-title'] !== undefined)
        .map(node => node.children.join(''));
      expect(paneTitles).toEqual(['Needle task']);

      // The popup answers a different question: what the daemon matched NOW.
      // Keeping its query-time summary preserves valid post-mount hits and the
      // freshest title, while the actionable pane remains on mounted evidence.
      const popupTasks = surface.root.findAll(node => node.props['data-result-kind'] === 'task');
      expect(popupTasks).toHaveLength(1);
      expect(popupTasks[0]?.findAllByType('span')[0]?.children.join('')).toBe('Query payload title');
    } finally {
      run(() => surface.unmount());
    }
  });

  test('shares the current task read without starting another request', async () => {
    let resolveTasks: ((response: Response) => void) | undefined;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tasks')) {
        asked.push(url.pathname);
        return await new Promise<Response>(resolve => {
          resolveTasks = resolve;
        });
      }
      return Response.json(fileIndexResponse({ files: [] }));
    }) as typeof fetch;
    let waitForTasks: (() => Promise<void> | undefined) | undefined;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <TaskWaitProbe
          onReady={wait => {
            waitForTasks = wait;
          }}
        />
      </SessionSearchProvider>,
    );
    try {
      const pending = waitForTasks?.();
      expect(pending).toBeDefined();
      expect(asked).toEqual(['/v1/sessions/session-a/tasks']);
      if (resolveTasks === undefined) throw new Error('task read did not start');
      await runAsync(async () => {
        resolveTasks?.(Response.json(taskListResponse([])));
        await pending;
      });
      expect(asked).toHaveLength(1);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('keeps mounted tasks and names a failed filter after the popup is dismissed', async () => {
    const seen: Recorded[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      if (url.pathname.endsWith('/fs/index')) return Response.json(fileIndexResponse({ files: [] }));
      if (url.pathname.endsWith('/tasks') && url.searchParams.has('q'))
        return new Response('too busy', { status: 503 });
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse([needleTask()]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const input = surface.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();
      run(() => input.props.onBlur({ relatedTarget: null }));

      // Dismissing the transient popup cannot dismiss the only explanation of
      // a persistent pane filter. The stable mounted board remains actionable
      // while the pane states plainly that its narrowing answer failed.
      expect(surface.root.findAll(node => node.props['data-session-search-popup'] !== undefined)).toHaveLength(0);
      const notice = surface.root.findByProps({ 'data-task-filter-unavailable': '' });
      expect(notice.props.role).toBe('alert');
      expect(surface.root.findAllByProps({ 'data-task-id': 'F6' }).length).toBeGreaterThan(0);
      expect(queryTaskReads(seen)).toHaveLength(1);
      const drawn = JSON.stringify(surface.toJSON());
      expect(drawn).toContain('Task filtering failed; showing all mounted tasks.');
      expect(drawn).toContain('HTTP 503');
      expect(drawn).toContain('Needle task');
      expect(surface.root.findAll(node => node.type === 'span' && node.children.join('') === '1 task')).toHaveLength(1);
      expect(surface.root.findAll(node => node.type === 'span' && node.children.join('') === '0 tasks')).toHaveLength(
        0,
      );
    } finally {
      run(() => surface.unmount());
    }
  });

  test('keeps the optimistic completion while the daemon confirms it, including from Kanban', async () => {
    let answer: ((response: Response) => void) | undefined;
    const seen: Recorded[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      if (init?.method === 'POST')
        return new Promise<Response>(resolve => {
          answer = resolve;
        });
      if (url.pathname.endsWith('/fs/index')) return Promise.resolve(Response.json(fileIndexResponse({ files: [] })));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json(taskListResponse([liveTask()])));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const kanban = surface.root.findAllByType('button').find(button => button.children.join('') === 'Kanban');
      run(() => kanban?.props.onClick());
      const done = surface.root.findByProps({ 'aria-label': 'Mark &F6 done' });
      await runAsync(async () => {
        done.props.onClick();
        await Promise.resolve();
      });
      // The overlay is SUMMARY-shaped: the row it shadows came from the list read,
      // and there is no detail record to build an optimistic view out of.
      expect(JSON.stringify(surface.toJSON())).toContain('Marked done from Tasks.');
      expect(JSON.stringify(surface.toJSON())).not.toContain('Mark done');

      await runAsync(async () => {
        answer?.(Response.json(confirmedView('Confirmed by daemon.')));
        await settle();
      });

      // The POST answers with a full view; it is projected back through the same
      // summary adapter before it is stored, so the row keeps one shape.
      expect(JSON.stringify(surface.toJSON())).toContain('Confirmed by daemon.');
      expect(JSON.stringify(surface.toJSON())).not.toContain('The daemon refused');
      // Never a detail read merely to keep an action button alive.
      expect(taskDetailReads(seen)).toHaveLength(0);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('restores live work and visibly explains when the daemon refuses Mark Done', async () => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') return Promise.resolve(new Response('forbidden', { status: 403 }));
      if (url.pathname.endsWith('/fs/index')) return Promise.resolve(Response.json(fileIndexResponse({ files: [] })));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json(taskListResponse([liveTask()])));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const done = surface.root.findByProps({ 'aria-label': 'Mark &F6 done' });
      await runAsync(async () => {
        done.props.onClick();
        await settle();
      });

      expect(JSON.stringify(surface.toJSON())).toContain('The daemon refused to mark this task done (HTTP 403).');
      expect(surface.root.findByProps({ 'aria-label': 'Mark &F6 done' })).toBeDefined();
    } finally {
      run(() => surface.unmount());
    }
  });

  test('carries one request id per logical Mark Done, and a fresh one for a fresh click', async () => {
    const requestIds: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        requestIds.push(String(new Headers(init.headers).get(FY_REQUEST_ID_HEADER)));
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      if (url.pathname.endsWith('/fs/index')) return Promise.resolve(Response.json(fileIndexResponse({ files: [] })));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json(taskListResponse([liveTask()])));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      for (let click = 0; click < 2; click += 1) {
        const done = surface.root.findByProps({ 'aria-label': 'Mark &F6 done' });
        await runAsync(async () => {
          done.props.onClick();
          await settle();
        });
      }

      expect(requestIds).toHaveLength(2);
      // A uuid per click, not per render and not one shared by both: the daemon
      // deduplicates on this header, so a second deliberate attempt that reused
      // the first id would be answered with the first refusal.
      for (const id of requestIds)
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      expect(new Set(requestIds).size).toBe(2);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('states loading and unavailable evidence instead of replacing either with an empty task list', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const loading = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    expect(JSON.stringify(loading.toJSON())).toContain('Loading task search evidence');
    run(() => loading.unmount());

    globalThis.fetch = (async () => new Response('gone', { status: 500 })) as unknown as typeof fetch;
    const unavailable = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const input = unavailable.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'anything' } }));
      expect(JSON.stringify(unavailable.toJSON())).toContain('Tasks are unavailable');
      expect(JSON.stringify(unavailable.toJSON())).toContain('Files unavailable');
    } finally {
      run(() => unavailable.unmount());
    }
  });
});

// The CURRENT SESSION's board, and the name matters. A task id is session-local,
// so a bare `&F12` cannot identify — let alone prove — a task belonging to some
// other session, and `/v1/tasks` is a fleet union rather than a shared board.
// Calling this "the aggregate board" would claim a reach these actions do not
// have; the true shared-board half of #43 is a declared GAP.
describe('Add to chat from the current-session task board', () => {
  test('delivers the reference into the composer of exactly this daemon session', async () => {
    const mine = composerAt(scope, 'look at');
    // Same session id, different daemon — the one delivery that must never
    // happen, because a task id is session-local and would name other work.
    const stranger = composerAt(
      daemonSessionScope(
        daemonConnection({ daemonId: 'other-daemon', baseUrl: 'https://other.example.test', deviceToken: 'other' }),
        'session-a',
      ),
      '',
    );
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const add = surface.root.findByProps({ 'aria-label': 'Add &F6 to chat' });
      run(() => {
        add.props.onClick();
      });

      expect(mine.draft).toBe('look at &F6 ');
      expect(stranger.draft).toBe('');
      expect(JSON.stringify(surface.toJSON())).toContain("Added &F6 to this session's message.");
    } finally {
      run(() => surface.unmount());
    }
  });

  test('says so rather than repeating a reference the draft already carries', async () => {
    const mine = composerAt(scope, '&F6 ');
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => {
        surface.root.findByProps({ 'aria-label': 'Add &F6 to chat' }).props.onClick();
      });

      expect(mine.draft).toBe('&F6 ');
      expect(JSON.stringify(surface.toJSON())).toContain('&F6 is already in this message.');
    } finally {
      run(() => surface.unmount());
    }
  });

  test('reports an absent composer instead of silently dropping the reference', async () => {
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => {
        surface.root.findByProps({ 'aria-label': 'Add &F6 to chat' }).props.onClick();
      });

      expect(JSON.stringify(surface.toJSON())).toContain('No message box is open for this session');
    } finally {
      run(() => surface.unmount());
    }
  });

  test('offers the action on Kanban as well as List, on the same exact scope', async () => {
    const mine = composerAt(scope);
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const kanban = surface.root.findAllByType('button').find(button => button.children.join('') === 'Kanban');
      run(() => kanban?.props.onClick());
      run(() => {
        surface.root.findByProps({ 'aria-label': 'Add &F6 to chat' }).props.onClick();
      });

      expect(mine.draft).toBe('&F6 ');
    } finally {
      run(() => surface.unmount());
    }
  });
});

/**
 * The published scope and the published evidence must describe the SAME session
 * in every single render, not merely once the effects have run.
 *
 * A render publishes new props immediately; an effect that clears stale state is
 * passive and runs after the commit. When the snapshot was unkeyed, that gap was
 * one committed render in which daemon beta's scope travelled with daemon
 * alpha's ready task list — and everything downstream reads the pair, so the
 * reference surface proved `&F6` against a session that has no F6, and an Add to
 * chat or Mark Done fired in that window addressed beta with alpha's task.
 *
 * This records the context value on EVERY render, during render, because an
 * observation taken in an effect is exactly the observation that misses it.
 */
describe('the published scope and the published evidence never disagree', () => {
  interface Observation {
    readonly daemonId: string | undefined;
    readonly taskState: SessionSearchResourceState;
    readonly taskIds: readonly string[];
    /** What the workspace's reference surface would prove from THIS pairing. */
    readonly resolvesF6: boolean;
    readonly query: string;
    readonly presenting: string | null;
    readonly activeResultKey: string | null;
  }

  type SearchController = Pick<ReturnType<typeof useSessionSearch>, 'present' | 'setActiveIndex' | 'setQuery'>;

  function ScopeProbe({
    onObserve,
    onControl,
  }: {
    readonly onObserve: (observation: Observation) => void;
    readonly onControl: (control: SearchController) => void;
  }) {
    const search = useSessionSearch();
    // Mirrors SessionChatPage: ready evidence for the scope on screen becomes
    // the task snapshot the session's one reference surface proves against.
    // A SUMMARY is enough — `SessionReferenceSurfaceOptions.tasks` needs an id
    // and nothing else, which is why the prose loss is harmless here.
    const referenceTasks = search.taskState === 'ready' ? search.tasks : undefined;
    const surface =
      search.scope === null
        ? null
        : sessionReferenceSurface({
            connection: search.connection,
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
      deviceToken: 'alpha-token',
    });
    const beta = daemonConnection({
      daemonId: 'beta',
      baseUrl: 'https://beta.example.test',
      deviceToken: 'beta-token',
    });
    // The same session id on both daemons — the arrangement in which a stale
    // pairing is invisible to any check that compares session ids alone.
    const alphaScope = daemonSessionScope(alpha, 'shared');
    const betaScope = daemonSessionScope(beta, 'shared');
    const alphaTask = boardTask({ id: 'F6', title: 'Needle task' }, {}, 'shared');
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const owned = url.host === 'alpha.example.test' ? [alphaTask] : [];
      if (url.pathname.endsWith('/fs/index'))
        return Response.json(fileIndexResponse({ files: [], sessionId: 'shared' }));
      if (url.pathname.endsWith('/tasks')) return Response.json(taskListResponse(owned, { sessionId: 'shared' }));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const seen: Observation[] = [];
    let control: SearchController | undefined;
    const observe = (observation: Observation): void => {
      seen.push(observation);
    };
    const captureControl = (current: SearchController): void => {
      control = current;
    };
    const tree = render(
      <SessionSearchProvider connection={alpha} focusSignal={0} scope={alphaScope}>
        <ScopeProbe onControl={captureControl} onObserve={observe} />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      // Guard the guard: without this the test would pass on a provider that
      // never reaches ready at all.
      expect(seen.some(o => o.daemonId === 'alpha' && o.taskState === 'ready' && o.taskIds.includes('F6'))).toBe(true);
      expect(seen.some(o => o.daemonId === 'alpha' && o.resolvesF6)).toBe(true);

      if (control === undefined) throw new Error('scope probe never published its search controls');
      run(() => {
        control?.setQuery('needle');
        control?.present('scope-probe');
      });
      await afterQuerySettles();
      // Select after the query settles so setActiveIndex sees the result set the
      // reader is actually looking at, rather than the previous empty one.
      run(() => control?.setActiveIndex(0));
      expect(seen.at(-1)).toMatchObject({
        query: 'needle',
        presenting: 'scope-probe',
        activeResultKey: 'task:F6',
      });

      const before = seen.length;
      await runAsync(async () => {
        tree.update(
          <SessionSearchProvider connection={beta} focusSignal={0} scope={betaScope}>
            <ScopeProbe onControl={captureControl} onObserve={observe} />
          </SessionSearchProvider>,
        );
        await settle();
      });

      const onBeta = seen.slice(before).filter(o => o.daemonId === 'beta');
      expect(onBeta.length).toBeGreaterThan(0);
      // Not one observation of beta may carry alpha's task…
      expect(onBeta.filter(o => o.taskIds.includes('F6'))).toEqual([]);
      // …and none may let the production reference composition prove it there.
      expect(onBeta.filter(o => o.resolvesF6)).toEqual([]);
      // The very first render under beta already reports unread rather than
      // inheriting alpha's ready: that is what makes it synchronous.
      expect(onBeta[0]?.taskState).toBe('loading');
      // Beta's own read still lands, so this is a reset and not a freeze.
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

/**
 * The interaction layer (#6 G2–G5, G7). Everything below drives the CONTROL —
 * its keyboard contract, which mount presents the popup, what the trailing slot
 * is allowed to claim, and the order and cap of what it lists.
 */
describe('current-session search control', () => {
  /** A key event as the control reads it: a key, a composing flag, a default. */
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
    props: { readonly shortcutTarget?: boolean; readonly touchAffected?: boolean } = {},
    openers?: { readonly onFile: (path: string) => void; readonly onTasks: () => void },
  ) => {
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        {openers ? <SearchOpeners onFile={openers.onFile} onTasks={openers.onTasks} /> : null}
        <SessionSearchControl {...props} />
      </SessionSearchProvider>,
    );
    await settle();
    return view;
  };

  const popup = (view: ReturnType<typeof render>) =>
    view.root.findAll(node => String(node.props.className).includes('z-[80]'));

  const rows = (view: ReturnType<typeof render>) => popup(view)[0]?.findAllByType('button') ?? [];

  /** Types, then waits for the one settled `?q=` the keystrokes earned. */
  const search = async (view: ReturnType<typeof render>, value: string): Promise<void> => {
    run(() => view.root.findByType('input').props.onChange({ target: { value } }));
    await afterQuerySettles();
  };

  test('reads its exact daemon session over two requests, then opens matched results', async () => {
    const opened: string[] = [];
    const seen = install();
    const surface = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SearchOpeners onFile={path => opened.push(`file:${path}`)} onTasks={() => opened.push('tasks')} />
        <SessionTasksSearchSurface />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      expect(surface.root.findByProps({ 'data-task-id': 'F6' })).toBeDefined();

      const input = surface.root.findByType('input');
      // Opening a result also DISMISSES the popup, so each activation starts
      // from a freshly presented list rather than from rows the previous click
      // has already unmounted.
      const listed = async (): Promise<ReturnType<typeof surface.root.findAllByType>> => {
        run(() => input.props.onChange({ target: { value: 'needle' } }));
        await afterQuerySettles();
        return surface.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
      };
      const first = await listed();
      expect(first).toHaveLength(2);
      run(() => first[0]?.props.onClick());
      const second = await listed();
      run(() => second[1]?.props.onClick());
      // Ranked, so `src/needle.ts` leads: it matches in both its name and its
      // path, while the task matches only in its title. Both rows still open
      // their own destination, which is what this test is about.
      expect(opened).toEqual(['file:src/needle.ts', 'tasks']);
      expect(taskDetailReads(seen)).toHaveLength(0);
      expect(listingReads(seen)).toHaveLength(0);
    } finally {
      run(() => surface.unmount());
    }
  });

  test('caps the presented rows and says exactly how many it is holding back', async () => {
    install({
      tasks: [],
      index: fileIndexResponse({
        files: Array.from({ length: MAX_SESSION_SEARCH_RESULTS + 5 }, (_, index) => ({
          name: `needle-${index}.ts`,
          path: `needle-${index}.ts`,
        })),
      }),
    });
    const view = await mountControl();
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
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      const inputs = view.root.findAllByType('input');
      expect(inputs).toHaveLength(2);

      // TWO MOUNTS, TWO IDS. One literal id shared by the app bar and an open
      // pane is a duplicate DOM id, and the label then points at whichever the
      // browser happened to find first.
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

      // The second mount claiming focus moves the popup rather than adding one.
      run(() => second?.props.onFocus());
      expect(popup(view)).toHaveLength(1);
      expect(first?.props['aria-expanded']).toBe(false);
      expect(second?.props['aria-expanded']).toBe(true);
      // The query is shared, so moving presentation never re-filters anything.
      expect(second?.props.value).toBe('needle');
    } finally {
      run(() => view.unmount());
    }
  });

  test('spends one query request however many mounts share the box', async () => {
    // The query belongs to the PROVIDER, not to a control. Two mounts reading one
    // shared query may not each dial the daemon about it.
    const seen = install();
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl />
        <SessionSearchControl />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      run(() => view.root.findAllByType('input')[0]?.props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();

      expect(queryTaskReads(seen)).toHaveLength(1);
      expect(bareTaskReads(seen)).toHaveLength(1);
      expect(indexReads(seen)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('lets exactly one mount answer the shared global focus signal', async () => {
    let focusCount = 0;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl shortcutTarget />
        <SessionSearchControl />
      </SessionSearchProvider>,
      {
        createNodeMock: element =>
          element.type === 'input'
            ? {
                focus: () => {
                  focusCount += 1;
                },
                select: () => undefined,
              }
            : null,
      },
    );
    try {
      await settle();
      run(() =>
        view.update(
          <SessionSearchProvider connection={daemon} focusSignal={3} scope={scope}>
            <SessionSearchControl shortcutTarget />
            <SessionSearchControl />
          </SessionSearchProvider>,
        ),
      );
      expect(focusCount).toBe(1);
      expect(popup(view)).toHaveLength(1);
      expect(view.root.findAllByType('input').filter(node => node.props['aria-expanded'] === true)).toHaveLength(1);
    } finally {
      run(() => view.unmount());
    }
  });

  test('does not replay an already-consumed focus signal when the control remounts', async () => {
    let focusCount = 0;
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={7} scope={scope}>
        <SessionSearchControl shortcutTarget />
      </SessionSearchProvider>,
      {
        createNodeMock: element =>
          element.type === 'input'
            ? {
                focus: () => {
                  focusCount += 1;
                },
                select: () => undefined,
              }
            : null,
      },
    );
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
      // Not a tab stop: the text box owns the only one.
      expect(listed.every(row => row.props.tabIndex === -1)).toBe(true);

      const down = keyEvent('ArrowDown');
      run(() => input.props.onKeyDown(down));
      expect(down.defaultPrevented).toBe(true);
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(listed[1]?.props.id);

      // Wraps at the end rather than stopping dead.
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
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json(taskListResponse([needleTask()])));
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
      await runAsync(
        async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
      );
      expect(view.root.findByProps({ 'aria-live': 'polite' }).children.join('')).toBe('');

      await runAsync(async () => {
        releaseIndex?.(Response.json(fileIndexResponse({ files: [{ name: 'needle.ts', path: 'src/needle.ts' }] })));
        await settle();
      });
      await runAsync(
        async () => await new Promise(resolve => setTimeout(resolve, SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS + 20)),
      );

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

      // An IME candidate window owns the arrows and Enter while it is up.
      const composing = keyEvent('ArrowDown', true);
      run(() => input.props.onKeyDown(composing));
      expect(composing.defaultPrevented).toBe(false);
      expect(view.root.findByType('input').props['aria-activedescendant']).toBe(before);

      const composingEscape = keyEvent('Escape', true);
      run(() => input.props.onKeyDown(composingEscape));
      expect(composingEscape.defaultPrevented).toBe(false);
      expect(popup(view)).toHaveLength(1);

      // Some engines expose composition only through the legacy 229 sentinel;
      // it receives the same protection as `isComposing`.
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
      const listed = rows(view);
      const activeKind = listed[0]?.props['data-result-kind'];

      const enter = keyEvent('Enter');
      run(() => input.props.onKeyDown(enter));

      expect(enter.defaultPrevented).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.startsWith(activeKind === 'file' ? 'file:' : 'tasks')).toBe(true);
      // Activating dismisses; a popup left open over the thing it just opened is
      // a popup the reader has to dismiss twice.
      expect(popup(view)).toHaveLength(0);
    } finally {
      run(() => view.unmount());
    }
  });

  test('dismisses on Escape WITHOUT clearing the query the Tasks list is filtered by', async () => {
    const view = await mountControl();
    try {
      await search(view, 'needle');
      const input = view.root.findByType('input');
      expect(popup(view)).toHaveLength(1);

      const escapeKey = keyEvent('Escape');
      run(() => input.props.onKeyDown(escapeKey));

      expect(escapeKey.defaultPrevented).toBe(true);
      expect(popup(view)).toHaveLength(0);
      // THE QUERY SURVIVES. It is shared context and also drives the Tasks
      // list's own filter, so clearing it here would silently unfilter a
      // surface nobody dismissed.
      expect(view.root.findByType('input').props.value).toBe('needle');

      // A second Escape on an already-dismissed control is not this control's
      // key to swallow.
      const again = keyEvent('Escape');
      run(() => input.props.onKeyDown(again));
      expect(again.defaultPrevented).toBe(false);

      // Typing brings it back without any other gesture.
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
    const indexing = await mountControl();
    try {
      const input = indexing.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(indexing.toJSON());

      expect(drawn).toContain("Indexing this session's files and tasks…");
      expect(drawn).not.toContain('Searching current-session data');
      // The trailing slot says the one true thing: an index still being built
      // outranks a shortcut hint.
      // By host node: the icon renders as a component AND the svg it returns,
      // and both carry the marker prop.
      expect(
        indexing.root.findAll(node => node.type === 'svg' && node.props['data-search-indexing'] !== undefined),
      ).toHaveLength(1);
      expect(indexing.root.findAll(node => node.props['data-search-shortcut'] !== undefined)).toHaveLength(0);
      // A half-built index is not a no-match answer.
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => indexing.unmount());
    }

    globalThis.fetch = (async () => Response.json({ entries: [] })) as unknown as typeof fetch;
    const broken = await mountControl();
    try {
      const input = broken.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      await afterQuerySettles();
      const drawn = JSON.stringify(broken.toJSON());

      expect(drawn).toContain('Tasks unavailable');
      expect(drawn).toContain('Files unavailable');
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => broken.unmount());
    }

    globalThis.fetch = (() => Promise.reject(new Error('Failed to fetch'))) as unknown as typeof fetch;
    const refused = await mountControl();
    try {
      const input = refused.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      expect(JSON.stringify(refused.toJSON())).toContain(
        'Tasks unavailable: Failed to fetch. Files unavailable: Failed to fetch.',
      );
    } finally {
      run(() => refused.unmount());
    }
  });

  test('names only the independently moving half and does not repeat it inside a refusal alert', async () => {
    let releaseTasks: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return Promise.resolve(Response.json(fileIndexResponse({ files: [] })));
      if (url.pathname.endsWith('/tasks'))
        return new Promise<Response>(resolve => {
          releaseTasks = resolve;
        });
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const tasksMoving = await mountControl();
    try {
      const input = tasksMoving.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(tasksMoving.toJSON());
      expect(drawn).toContain("Indexing this session's tasks…");
      expect(drawn).not.toContain("Indexing this session's files…");
      await runAsync(async () => {
        releaseTasks?.(Response.json(taskListResponse([])));
        await settle();
      });
    } finally {
      run(() => tasksMoving.unmount());
    }

    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs/index')) return new Promise<Response>(() => undefined);
      if (url.pathname.endsWith('/tasks')) return Promise.reject(new Error('task read refused'));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const failedTasks = await mountControl();
    try {
      const input = failedTasks.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(failedTasks.toJSON());
      expect(drawn).toContain('Tasks unavailable: task read refused.');
      expect(drawn).toContain("Indexing this session's files…");
      expect(drawn.match(/Indexing/g)).toHaveLength(1);
      expect(drawn).not.toContain('No current-session files or tasks match');
    } finally {
      run(() => failedTasks.unmount());
    }
  });

  test('prints a shortcut only on a device that has one, in that platform’s own spelling', async () => {
    const keyboard = await mountControl({ touchAffected: false });
    try {
      const hint = keyboard.root.findAll(node => node.props['data-search-shortcut'] !== undefined);
      expect(hint).toHaveLength(1);
      expect(JSON.stringify(keyboard.toJSON())).toContain(paletteShortcutLabel());
      expect(keyboard.root.findByType('input').props['aria-keyshortcuts']).toBe(PALETTE_KEYSHORTCUTS);
    } finally {
      run(() => keyboard.unmount());
    }

    // A phone has no ⌘ and no Ctrl. Printing one is the exact mistake
    // `palette-shortcut.ts` exists to prevent, so the slot stays empty — while
    // the shortcut itself remains DECLARED, because a paired keyboard can still
    // press it.
    const touch = await mountControl({ touchAffected: true });
    try {
      expect(touch.root.findAll(node => node.props['data-search-shortcut'] !== undefined)).toHaveLength(0);
      expect(touch.root.findByType('input').props['aria-keyshortcuts']).toBe(PALETTE_KEYSHORTCUTS);
    } finally {
      run(() => touch.unmount());
    }
  });

  test('answers an explicit shortcut with focus on every device, touch included', async () => {
    // `paletteFocusPolicy` withholds focus from a touch-affected reader when the
    // PALETTE opens itself. This is the other input domain: the reader pressed a
    // key chord, which is proof of a keyboard, and a tablet reporting a coarse
    // pointer must not have its deliberate keystroke ignored.
    let focused = 0;
    let selected = 0;
    // react-test-renderer gives host refs `null`, so a ref-gated effect silently
    // never runs without a node mock — the effect would look proved and be dead.
    const view = render(
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        <SessionSearchControl shortcutTarget touchAffected={true} />
      </SessionSearchProvider>,
      {
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
      },
    );
    try {
      await settle();
      run(() =>
        view.update(
          <SessionSearchProvider connection={daemon} focusSignal={2} scope={scope}>
            <SessionSearchControl shortcutTarget touchAffected={true} />
          </SessionSearchProvider>,
        ),
      );
      expect(focused).toBe(1);
      expect(selected).toBe(1);
      const input = view.root.findByType('input');
      expect(input.props.role).toBe('combobox');
      expect(input.props['aria-autocomplete']).toBe('list');
      // Answering the shortcut also PRESENTS before a query exists: the reader
      // asked to search, and a focused box over a hidden result list is half an
      // answer.
      expect(view.root.findAll(node => String(node.props.className).includes('z-[80]'))).toHaveLength(1);
      expect(JSON.stringify(view.toJSON())).toContain("Type to search this session's files and tasks.");
    } finally {
      run(() => view.unmount());
    }
  });
});
