/**
 * A ferret's card as its chat reads it, for the suites that feed the `&` menu, the proof and the search.
 *
 * The shape is the app's own (`SessionCard`), so a change to it breaks these fixtures at compile time.
 */

import type { SessionCard } from '../../src/lib/session-cards.ts';

export const sessionCard = (id: string, patch: Partial<SessionCard> = {}): SessionCard => ({
  id,
  title: `Title of ${id}`,
  summary: '',
  lane: 'To do',
  closed: false,
  active: false,
  assignee: null,
  touchedAt: '2026-10-01T00:00:00.000Z',
  legacyId: null,
  ...patch,
});
