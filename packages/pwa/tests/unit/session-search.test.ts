import { describe, expect, test } from 'bun:test';
import type { ScopedTaskView } from '@ferretry/protocol';
import { filterSessionSearchResults, matchesSessionSearch } from '../../src/features/session-search/session-search.tsx';
import { taskSummary } from '../support/tasks.ts';

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
});
