import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  CONTINUE_SOURCES,
  type ContinueEntry,
  type ContinueListing,
  type ContinueSource,
  continueEntries,
  conversationsQuery,
  ferretMark,
  keptConversationAction,
  keptConversationsQuery,
  sessionActivityAt,
} from '../../../../../src/features/fleet/conversations/continue-model.ts';
import { sessionView } from '../../../../support/sessions.ts';
import { conversation, NOW } from './conversation-support.ts';

const HOUR = 3_600_000;
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();

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
  conversation('c-shop', { adoptedBy: 's-stopped', preview: 'Fix the cart total', latest: 'ship it', daysAgo: 0.1 }),
  conversation('c-live', { adoptedBy: 's-run', harness: 'codex', preview: 'Tidy the release notes', daysAgo: 0.2 }),
  conversation('c-gone', { adoptedBy: 's-unknown', preview: 'Draft the invoice email', daysAgo: 20 }),
  conversation('c-free', { daysAgo: 2 }),
];
const ANY = { text: '', date: 'any' } as const;
const listing = (source: ContinueSource, overrides: Partial<ContinueListing> = {}): ContinueListing => ({
  source,
  searched: KEPT,
  kept: KEPT,
  sessions: SESSIONS,
  search: ANY,
  ...overrides,
});
const keys = (entries: readonly ContinueEntry[]): readonly string[] =>
  entries.map(entry =>
    entry.kind === 'conversation'
      ? `${entry.conversation.id}${entry.ferret === undefined ? '' : `@${entry.ferret.name}`}`
      : `ferret:${entry.ferret.name}`,
  );

describe('continue sources', () => {
  it('offers one list, narrowed to Ferretry, Claude or Codex', () => {
    expect(CONTINUE_SOURCES.map(source => source.label)).toEqual(['All', 'Ferretry', 'Claude', 'Codex']);
  });

  it('asks only for Ferretry’s own history, narrowed to a CLI when the source is one', () => {
    expect(conversationsQuery('claude', { text: ' cart ', date: 'any' }, NOW, 50)).toEqual({
      source: 'ferretry',
      harness: 'claude',
      q: 'cart',
      limit: 50,
    });
    expect(conversationsQuery('ferretry', ANY, NOW, 50)).toEqual({ source: 'ferretry', limit: 50 });
    expect(conversationsQuery('all', ANY, NOW, 50)).toEqual({ source: 'ferretry', limit: 50 });
    expect(keptConversationsQuery(1000)).toEqual({ source: 'ferretry', limit: 1000 });
  });
});

describe('the continue list', () => {
  it('shows every conversation newest first, each kept one marked by its ferret, and the bare stopped ferrets', () => {
    expect(keys(continueEntries(listing('all'), NOW))).toEqual([
      'ferret:Notes',
      'c-shop@Mika',
      'c-live@Session s-run',
      'c-free',
      'c-gone@s-unknown',
      'ferret:old',
    ]);
    expect(sessionActivityAt(running)).toBe(running.state.lastActivityAt as string);
  });

  it('marks a kept conversation with the ferret’s name and status, or its id when the ferret is unread', () => {
    const entries = continueEntries(listing('all'), NOW);
    const ferrets = entries.flatMap(entry => (entry.kind === 'conversation' && entry.ferret ? [entry.ferret] : []));
    expect(ferrets).toEqual([
      { id: 's-stopped', name: 'Mika', status: 'stopped' },
      { id: 's-run', name: 'Session s-run', status: 'running' },
      { id: 's-unknown', name: 's-unknown' },
    ]);
    expect(ferretMark(completed)).toEqual({ id: 's-done', name: 'Notes', status: 'completed' });
  });

  it('narrows Ferretry to the kept conversations, running or stopped, and the stopped ferrets', () => {
    expect(keys(continueEntries(listing('ferretry', { searched: [] }), NOW))).toEqual([
      'ferret:Notes',
      'c-shop@Mika',
      'c-live@Session s-run',
      'c-gone@s-unknown',
      'ferret:old',
    ]);
    const search = (text: string, date: 'any' | '7d' = 'any') =>
      keys(continueEntries(listing('ferretry', { search: { text, date } }), NOW));
    expect(search('CART ship')).toEqual(['c-shop@Mika']);
    expect(search('', '7d')).toEqual(['ferret:Notes', 'c-shop@Mika', 'c-live@Session s-run']);
    expect(search('work/notes')).toEqual(['ferret:Notes']);
    expect(search('nowhere')).toEqual([]);
  });

  it('narrows a CLI to its conversations and the stopped ferrets that drive it', () => {
    const codex = KEPT.filter(row => row.harness === 'codex');
    expect(keys(continueEntries(listing('codex', { searched: codex }), NOW))).toEqual([
      'ferret:Notes',
      'c-live@Session s-run',
    ]);
    const claude = KEPT.filter(row => row.harness === 'claude');
    expect(keys(continueEntries(listing('claude', { searched: claude }), NOW))).toEqual([
      'c-shop@Mika',
      'c-free',
      'c-gone@s-unknown',
      'ferret:old',
    ]);
  });

  it('reads a bare ferret only when the listing does not describe it', () => {
    expect(keys(continueEntries(listing('all', { kept: [], searched: [] }), NOW))).toEqual([
      'ferret:Notes',
      'ferret:Mika',
      'ferret:old',
    ]);
  });

  it('resumes a kept conversation whose ferret is stopped, and opens any other', () => {
    expect(keptConversationAction(conversation('a', { adoptedBy: 's-stopped' }), SESSIONS)).toBe('resume');
    expect(keptConversationAction(conversation('a', { adoptedBy: 's-run' }), SESSIONS)).toBe('open');
    expect(keptConversationAction(conversation('a', { adoptedBy: 'unknown' }), SESSIONS)).toBe('open');
  });
});
