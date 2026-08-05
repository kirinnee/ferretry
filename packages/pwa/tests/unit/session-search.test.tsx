import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ScopedTaskView } from '@ferretry/protocol';
import { useEffect } from 'react';
import {
  filterSessionSearchResults,
  matchesSessionSearch,
  SessionSearchProvider,
  SessionTasksSearchSurface,
  useSessionSearch,
} from '../../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../support/react.ts';
import { taskSummary } from '../support/tasks.ts';

const daemon = daemonConnection({
  daemonId: 'search-daemon',
  baseUrl: 'https://search.example.test',
  deviceToken: 'search-token',
});
const scope = daemonSessionScope(daemon, 'session-a');
const originalFetch = globalThis.fetch;

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

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
