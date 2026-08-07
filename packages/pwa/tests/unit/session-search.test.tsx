import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type ScopedTaskView } from '@ferretry/protocol';
import { useEffect } from 'react';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import {
  filterSessionSearchResults,
  matchesSessionSearch,
  MAX_SESSION_SEARCH_RESULTS,
  SESSION_SEARCH_ANNOUNCE_DEBOUNCE_MS,
  sessionSearchResultKey,
  SessionSearchControl,
  SessionSearchProvider,
  type SessionSearchResourceState,
  SessionTasksSearchSurface,
  useSessionSearch,
} from '../../src/features/session-search/session-search.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../../src/shell/palette-shortcut.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import { render, run, runAsync } from '../support/react.ts';
import { taskSummary } from '../support/tasks.ts';

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

const task = (overrides: Partial<ScopedTaskView> = {}): ScopedTaskView =>
  ({
    ...taskSummary({ id: 'F6', title: 'Find unmounted search' }),
    description: 'Search the current session quickly.',
    ask: { text: 'Find the task I half remember', source: 'human-message' },
    clarifications: [
      {
        text: 'Include original asks and every clarification.',
        source: 'human-message-2',
        at: '2026-08-05T00:00:00Z',
        by: 'user',
        byName: null,
      },
    ],
    sessionId: 'session-a',
    ...overrides,
  }) as ScopedTaskView;

function SearchOpeners({ onFile, onTasks }: { readonly onFile: (path: string) => void; readonly onTasks: () => void }) {
  const search = useSessionSearch();
  useEffect(() => {
    search.setOpeners({ openFile: onFile, openTasks: onTasks });
    return () => search.setOpeners(null);
  }, [onFile, onTasks, search]);
  return null;
}

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname.endsWith('/tasks/F6'))
      return Response.json({ activity: [], sessionId: 'session-a', task: task({ title: 'Needle task' }) });
    if (url.pathname.endsWith('/tasks')) return Response.json({ tasks: [task({ title: 'Needle task' })] });
    if (url.pathname.endsWith('/fs'))
      return Response.json(
        path === ''
          ? {
              entries: [
                { name: 'src', type: 'dir' },
                { name: 'README.md', type: 'file' },
              ],
            }
          : { entries: [{ name: 'needle.ts', type: 'file' }] },
      );
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
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

describe('current-session search model', () => {
  test('matches task identity and all three prose records without narrowing to a title', () => {
    const result = filterSessionSearchResults([task()], [], 'every clarification');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'task', task: { id: 'F6' } });
    expect(filterSessionSearchResults([task()], [], 'half remember')).toHaveLength(1);
    expect(filterSessionSearchResults([task()], [], 'current session quickly')).toHaveLength(1);
    expect(filterSessionSearchResults([task()], [], 'f6')).toHaveLength(1);
  });

  test('matches file names and full paths, case-insensitively', () => {
    const files = [
      { kind: 'file' as const, name: 'SessionSearch.tsx', path: 'packages/pwa/src/session/SessionSearch.tsx' },
    ];

    expect(filterSessionSearchResults([], files, 'sessionsearch')).toHaveLength(1);
    expect(filterSessionSearchResults([], files, 'packages/pwa')).toHaveLength(1);
    expect(matchesSessionSearch('SessionSearch.tsx', 'SEARCH')).toBe(true);
  });

  test('does not invent results for a blank query', () => {
    expect(filterSessionSearchResults([task()], [], '   ')).toEqual([]);
  });

  test('reads task details and recursive files from its exact daemon session, then opens matched results', async () => {
    const opened: string[] = [];
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
      const rows = (): ReturnType<typeof surface.root.findAllByType> => {
        run(() => input.props.onChange({ target: { value: 'needle' } }));
        return surface.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
      };
      const first = rows();
      expect(first).toHaveLength(2);
      run(() => first[0]?.props.onClick());
      // `rows()` runs its own `act`, so it is called between activations rather
      // than inside one: nesting `act` in `act` does not re-render.
      const second = rows();
      run(() => second[1]?.props.onClick());
      // Ranked, so `src/needle.ts` leads: it matches in both its name and its
      // path, while the task matches only in its title. Both rows still open
      // their own destination, which is what this test is about.
      expect(opened).toEqual(['file:src/needle.ts', 'tasks']);
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

    globalThis.fetch = (async () => Response.json({ entries: [], truncated: true })) as unknown as typeof fetch;
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
      expect(JSON.stringify(unavailable.toJSON())).toContain(
        'Files unavailable: The daemon returned an incomplete file listing.',
      );
    } finally {
      run(() => unavailable.unmount());
    }
  });

  test('keeps the optimistic completion while the daemon confirms it, including from Kanban', async () => {
    let answer: ((response: Response) => void) | undefined;
    const live = task({ phase: 'live', status: 'live' });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST')
        return new Promise<Response>(resolve => {
          answer = resolve;
        });
      if (url.pathname.endsWith('/tasks/F6'))
        return Promise.resolve(Response.json({ activity: [], sessionId: 'session-a', task: live }));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json({ tasks: [live] }));
      if (url.pathname.endsWith('/fs')) return Promise.resolve(Response.json({ entries: [] }));
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
      expect(JSON.stringify(surface.toJSON())).toContain('Marked done from Tasks.');
      expect(JSON.stringify(surface.toJSON())).not.toContain('Mark done');
      expect(answer).toBeDefined();

      await runAsync(async () => {
        answer?.(Response.json({ ...live, phase: 'done', status: 'done', statusReason: 'Confirmed by daemon.' }));
        await settle();
      });

      expect(JSON.stringify(surface.toJSON())).toContain('Confirmed by daemon.');
      expect(JSON.stringify(surface.toJSON())).not.toContain('The daemon refused');
    } finally {
      run(() => surface.unmount());
    }
  });

  test('restores live work and visibly explains when the daemon refuses Mark Done', async () => {
    const live = task({ phase: 'live', status: 'live' });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') return Promise.resolve(new Response('forbidden', { status: 403 }));
      if (url.pathname.endsWith('/tasks/F6'))
        return Promise.resolve(Response.json({ activity: [], sessionId: 'session-a', task: live }));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json({ tasks: [live] }));
      if (url.pathname.endsWith('/fs')) return Promise.resolve(Response.json({ entries: [] }));
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
    const live = task({ phase: 'live', status: 'live' });
    const requestIds: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        requestIds.push(String(new Headers(init.headers).get(FY_REQUEST_ID_HEADER)));
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      if (url.pathname.endsWith('/tasks/F6'))
        return Promise.resolve(Response.json({ activity: [], sessionId: 'session-a', task: live }));
      if (url.pathname.endsWith('/tasks')) return Promise.resolve(Response.json({ tasks: [live] }));
      if (url.pathname.endsWith('/fs')) return Promise.resolve(Response.json({ entries: [] }));
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
    const alphaTask = task({ id: 'F6', sessionId: 'shared' });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const owned = url.host === 'alpha.example.test' ? [alphaTask] : [];
      if (url.pathname.endsWith('/tasks/F6'))
        return Response.json({ activity: [], sessionId: 'shared', task: alphaTask });
      if (url.pathname.endsWith('/tasks')) return Response.json({ tasks: owned });
      if (url.pathname.endsWith('/fs')) return Response.json({ entries: [] });
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
        control?.setQuery('6');
        control?.present('scope-probe');
      });
      // Select after the query render so setActiveIndex sees the result set the
      // reader is actually looking at, rather than the previous empty one.
      run(() => control?.setActiveIndex(0));
      expect(seen.at(-1)).toMatchObject({
        query: '6',
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

  test('ranks a file matching name and path above a task matching only its title', () => {
    const ranked = filterSessionSearchResults(
      [task({ title: 'Needle task' })],
      [{ kind: 'file', name: 'needle.ts', path: 'src/needle.ts' }],
      'needle',
    );

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({ kind: 'file', path: 'src/needle.ts' });
    expect(ranked[1]).toMatchObject({ kind: 'task' });
  });

  test('keeps every substring member a rank of zero would have dropped', () => {
    // Membership matches the joined haystack's `F6`, while the ranking field
    // deliberately treats task ids as anchored and therefore scores the loose
    // query `6` as zero. The row must still be listed: ranking orders what
    // matching found, it does not re-decide it.
    const across = filterSessionSearchResults([task({ title: 'Needle task' })], [], '6');

    expect(across).toHaveLength(1);
    expect(across[0]).toMatchObject({ kind: 'task', task: { id: 'F6' } });
  });

  test('ranks stably, leaving equal scores in their original order', () => {
    const ranked = filterSessionSearchResults(
      [task({ id: 'F7', title: 'Needle task' }), task({ id: 'F8', title: 'Needle task' })],
      [],
      'needle',
    );

    expect(ranked.map(result => (result.kind === 'task' ? result.task.id : result.path))).toEqual(['F7', 'F8']);
  });

  test('caps the presented rows and says exactly how many it is holding back', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tasks')) return Response.json({ tasks: [] });
      if (url.pathname.endsWith('/fs'))
        return Response.json({
          entries: Array.from({ length: MAX_SESSION_SEARCH_RESULTS + 5 }, (_, index) => ({
            name: `needle-${index}.ts`,
            type: 'file',
          })),
        });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const view = await mountControl();
    try {
      await settle();
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));

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
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'e' } }));
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
    let releaseFiles: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tasks/F6'))
        return Promise.resolve(
          Response.json({ activity: [], sessionId: 'session-a', task: task({ title: 'Needle task' }) }),
        );
      if (url.pathname.endsWith('/tasks'))
        return Promise.resolve(Response.json({ tasks: [task({ title: 'Needle task' })] }));
      if (url.pathname.endsWith('/fs'))
        return new Promise<Response>(resolve => {
          releaseFiles = resolve;
        });
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const opened: string[] = [];
    const view = await mountControl(
      {},
      { onFile: path => opened.push(`file:${path}`), onTasks: () => opened.push('tasks') },
    );
    try {
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
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

      releaseFiles?.(Response.json({ entries: [{ name: 'needle.ts', type: 'file' }] }));
      await settle();
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
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'e' } }));
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
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
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
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
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
      const input = view.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
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

    globalThis.fetch = (async () => Response.json({ entries: [], truncated: true })) as unknown as typeof fetch;
    const broken = await mountControl();
    try {
      const input = broken.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(broken.toJSON());

      expect(drawn).toContain(
        'Tasks unavailable: The daemon returned an unreadable task list. Files unavailable: The daemon returned an incomplete file listing.',
      );
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
      if (url.pathname.endsWith('/tasks'))
        return new Promise<Response>(resolve => {
          releaseTasks = resolve;
        });
      if (url.pathname.endsWith('/fs')) return Promise.resolve(Response.json({ entries: [] }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    const tasksMoving = await mountControl();
    try {
      const input = tasksMoving.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const drawn = JSON.stringify(tasksMoving.toJSON());
      expect(drawn).toContain("Indexing this session's tasks…");
      expect(drawn).not.toContain("Indexing this session's files…");
      releaseTasks?.(Response.json({ tasks: [] }));
      await settle();
    } finally {
      run(() => tasksMoving.unmount());
    }

    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tasks')) return Promise.reject(new Error('task read refused'));
      if (url.pathname.endsWith('/fs')) return new Promise<Response>(() => undefined);
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
