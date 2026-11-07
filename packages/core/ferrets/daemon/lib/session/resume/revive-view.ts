import { reviveRuling } from '../../protocol/session-revive.ts';
import { type SessionView } from '../../protocol/session.ts';
import type { SessionDirectorySubsystem } from '../../runtime/mounts/sessions.ts';
import { createViewMemo } from '../directory/view-memo.ts';

/**
 * Puts `revive: { revivable, reason }` on every session view the daemon serves, so each Resume button in
 * every app asks one place instead of deciding from the status on its own. It wraps the session reader at
 * the mount, like `withOutdated`, and is computed on read from the status alone — nothing is stored.
 */
export function withRevive(reader: SessionDirectorySubsystem): SessionDirectorySubsystem {
  const memo = createViewMemo<undefined>();
  const mark = (view: SessionView): SessionView =>
    memo(view, undefined, () => ({ ...view, revive: reviveRuling(view.state.status) }));
  return {
    list: async () => (await reader.list()).map(mark),
    get: async reference => {
      const view = await reader.get(reference);
      return view === undefined ? undefined : mark(view);
    },
  };
}
