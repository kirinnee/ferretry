import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type ScopedTaskView } from '@ferretry/protocol';
import { useEffect } from 'react';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import {
  filterSessionSearchResults,
  matchesSessionSearch,
  SessionSearchProvider,
  type SessionSearchResourceState,
  SessionTasksSearchSurface,
  useSessionSearch,
} from '../../src/features/session-search/session-search.tsx';
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

function TaskWaitProbe({ onReady }: { readonly onReady: (wait: () => Promise<void> | undefined) => void }) {
  onReady(useSessionSearch().waitForTasks);
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
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const results = surface.root
        .find(node => String(node.props.className).includes('z-[80]'))
        .findAllByType('button');
      expect(results).toHaveLength(2);
      run(() => results[0]?.props.onClick());
      run(() => results[1]?.props.onClick());
      expect(opened).toEqual(['tasks', 'file:src/needle.ts']);
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
      return Response.json({ entries: [] });
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
        resolveTasks?.(Response.json({ tasks: [] }));
        await pending;
      });
      expect(asked).toHaveLength(1);
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
      expect(JSON.stringify(unavailable.toJSON())).toContain('Files unavailable.');
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
  }

  function ScopeProbe({ onObserve }: { readonly onObserve: (observation: Observation) => void }) {
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
    onObserve({
      daemonId: search.scope?.daemonId,
      taskState: search.taskState,
      taskIds: search.tasks.map(task => task.id),
      resolvesF6: surface?.taskReferenceResolver?.({ form: 'local', id: 'F6' })?.id === 'F6',
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
    const observe = (observation: Observation): void => {
      seen.push(observation);
    };
    const tree = render(
      <SessionSearchProvider connection={alpha} focusSignal={0} scope={alphaScope}>
        <ScopeProbe onObserve={observe} />
      </SessionSearchProvider>,
    );
    try {
      await settle();
      // Guard the guard: without this the test would pass on a provider that
      // never reaches ready at all.
      expect(seen.some(o => o.daemonId === 'alpha' && o.taskState === 'ready' && o.taskIds.includes('F6'))).toBe(true);
      expect(seen.some(o => o.daemonId === 'alpha' && o.resolvesF6)).toBe(true);

      const before = seen.length;
      await runAsync(async () => {
        tree.update(
          <SessionSearchProvider connection={beta} focusSignal={0} scope={betaScope}>
            <ScopeProbe onObserve={observe} />
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
      expect(seen.at(-1)).toMatchObject({ daemonId: 'beta', taskState: 'ready', taskIds: [] });
    } finally {
      run(() => tree.unmount());
    }
  });
});
