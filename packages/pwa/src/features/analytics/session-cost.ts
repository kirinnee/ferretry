/**
 * WHAT ONE SESSION COST, and what it cost together with everything it spawned — as pure data.
 *
 * The session pane answers two numbers before anything else: this session, and this session with its
 * children. Children are found by walking `parent` links inside the session's tree, so a session in the
 * middle of a tree counts its own descendants and never its siblings or its parent.
 */

import type { AnalyticsRawSession } from '@ferretry/protocol';

import { type AnalyticsModelShare, analyticsModelShares } from './analytics-overview.ts';

export interface SessionCost {
  readonly session: AnalyticsRawSession;
  readonly children: number;
  /** Known cost of the session and its descendants, in micro-dollars. */
  readonly withChildrenMicros: number;
  /** How many of the session and its descendants could not be priced. */
  readonly unpriced: number;
  readonly models: readonly AnalyticsModelShare[];
  /** The tree read came back truncated, so the children counted may be fewer than exist. */
  readonly childrenPartial: boolean;
  /** Cache reads as a share of input tokens, 0-100, or null when unknown. */
  readonly cacheReadPercent: number | null;
}

/** Every session below `id` in `rows`, found through `parent` links. */
export const sessionDescendants = (
  rows: readonly AnalyticsRawSession[],
  id: string,
): readonly AnalyticsRawSession[] => {
  const found: AnalyticsRawSession[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const next = rows.filter(row => row.parent !== null && frontier.includes(row.parent) && !seen.has(row.id));
    for (const row of next) seen.add(row.id);
    found.push(...next);
    frontier = next.map(row => row.id);
  }
  return found;
};

/**
 * The tree query that both finds a session's children and is offered as "Open in Analytics": every
 * session in the tree the session belongs to. `==` keeps the id exact, which a tree matcher requires.
 */
export const sessionTreeMatcher = (session: Pick<AnalyticsRawSession, 'id' | 'tree'>): string =>
  `{tree==${JSON.stringify(session.tree ?? session.id)}}`;

export const sessionCost = (
  session: AnalyticsRawSession,
  tree: readonly AnalyticsRawSession[],
  treeTruncated: boolean,
): SessionCost => {
  const descendants = sessionDescendants(tree, session.id);
  const members = [session, ...descendants];
  const input = session.inputTokens;
  const cached = session.cachedInputTokens;
  return {
    session,
    children: descendants.length,
    withChildrenMicros: members.reduce((sum, member) => sum + (member.equivalentApiCostUsdMicros ?? 0), 0),
    unpriced: members.filter(member => member.equivalentApiCostUsdMicros === null).length,
    models: analyticsModelShares(members),
    childrenPartial: treeTruncated,
    cacheReadPercent: input !== null && cached !== null && input > 0 ? (100 * cached) / input : null,
  };
};
