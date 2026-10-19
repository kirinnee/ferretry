import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  CONTINUE_SOURCES,
  conversationsQuery,
  keptConversationAction,
  keptConversationsQuery,
  sessionActivityAt,
  stoppedSessionRows,
} from '../../../../../src/features/fleet/conversations/continue-model.ts';
import { sessionView } from '../../../../support/sessions.ts';
import { conversation, NOW } from './conversation-support.ts';

const HOUR = 3_600_000;
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();
const ANY = { text: '', harness: 'all', date: 'any' } as const;

const stopped = sessionView('s-stopped', {
  config: { name: 'shop', teammate: 'mika', cwd: '/work/shop' },
  state: { status: 'stopped', lastActivityAt: at(3) },
});
const completed = sessionView('s-done', {
  config: { name: 'notes', label: 'Notes', harness: 'codex', cwd: '/work/notes' },
  state: { status: 'completed', lastActivityAt: at(1) },
});
const failedOld = sessionView('s-old', {
  config: { name: 'old', updatedAt: at(24 * 40) },
  state: { status: 'failed', lastActivityAt: undefined },
});
const running = sessionView('s-run', { state: { status: 'running' } });
const SESSIONS: readonly SessionView[] = [stopped, completed, failedOld, running];
const KEPT = [
  conversation('c-shop', { adoptedBy: 's-stopped', preview: 'Fix the cart total', latest: 'ship it' }),
  conversation('c-free'),
];

describe('continue sources', () => {
  it('offers the ferrets first, then every conversation', () => {
    expect(CONTINUE_SOURCES.map(source => source.label)).toEqual(['Ferretry sessions', 'All conversations']);
  });

  it('asks only for Ferretry’s own history', () => {
    expect(conversationsQuery({ text: ' cart ', harness: 'claude', date: 'any' }, NOW, 50)).toEqual({
      source: 'ferretry',
      harness: 'claude',
      q: 'cart',
      limit: 50,
    });
    expect(keptConversationsQuery(1000)).toEqual({ source: 'ferretry', limit: 1000 });
  });
});

describe('stopped ferrets', () => {
  it('lists every stopped ferret newest first, with the conversation it keeps', () => {
    const rows = stoppedSessionRows(SESSIONS, KEPT, ANY, NOW);
    expect(rows.map(row => [row.view.config.id, row.name, row.conversation?.id])).toEqual([
      ['s-done', 'Notes', undefined],
      ['s-stopped', 'Mika', 'c-shop'],
      ['s-old', 'old', undefined],
    ]);
    expect(rows[2]?.lastActivityAt).toBe(at(24 * 40));
    expect(sessionActivityAt(running)).toBe(running.state.lastActivityAt as string);
  });

  it('narrows by the CLI, the date and every word, in the name, messages or folder', () => {
    const ids = (search: Parameters<typeof stoppedSessionRows>[2]) =>
      stoppedSessionRows(SESSIONS, KEPT, search, NOW).map(row => row.view.config.id);
    expect(ids({ ...ANY, harness: 'codex' })).toEqual(['s-done']);
    expect(ids({ ...ANY, date: '7d' })).toEqual(['s-done', 's-stopped']);
    expect(ids({ ...ANY, text: 'CART ship' })).toEqual(['s-stopped']);
    expect(ids({ ...ANY, text: 'mika' })).toEqual(['s-stopped']);
    expect(ids({ ...ANY, text: 'work/notes' })).toEqual(['s-done']);
    expect(ids({ ...ANY, text: 'nowhere' })).toEqual([]);
  });

  it('resumes a kept conversation whose ferret is stopped, and opens any other', () => {
    expect(keptConversationAction(conversation('a', { adoptedBy: 's-stopped' }), SESSIONS)).toBe('resume');
    expect(keptConversationAction(conversation('a', { adoptedBy: 's-run' }), SESSIONS)).toBe('open');
    expect(keptConversationAction(conversation('a', { adoptedBy: 'unknown' }), SESSIONS)).toBe('open');
  });
});
