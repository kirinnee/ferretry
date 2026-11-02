import type { DaemonStorage } from '../storage/session-storage.ts';

const text = (document: unknown, key: string): string | undefined => {
  if (typeof document !== 'object' || document === null) return undefined;
  const value = (document as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/**
 * The session an owner's own card goes on when they named none: the most recently active session that has not ended.
 *
 * Every card in the app's Inbox belongs to a session, and the person at their own shell has none of their own, so the
 * daemon picks one the person is most likely looking at. `undefined` when no session is running, which the caller says
 * out loud rather than guessing a board. Ties and missing times fall back to the session id, so the answer is stable.
 */
export async function mostRecentLiveSession(
  storage: Pick<DaemonStorage, 'listSessions' | 'readState'>,
  ended: ReadonlySet<string>,
): Promise<string | undefined> {
  const live = await Promise.all(
    storage.listSessions().map(async indexed => {
      const state = await storage.readState(indexed.id).catch(() => undefined);
      const status = text(state, 'status');
      if (state === undefined || status === undefined || ended.has(status)) return undefined;
      const active = text(state, 'lastActivityAt') ?? text(state, 'startedAt') ?? '';
      return { id: String(indexed.id), active };
    }),
  );
  const ranked = live
    .filter((entry): entry is { id: string; active: string } => entry !== undefined)
    .sort((a, b) => (a.active === b.active ? a.id.localeCompare(b.id) : b.active.localeCompare(a.active)));
  return ranked[0]?.id;
}
