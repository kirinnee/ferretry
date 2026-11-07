/**
 * THE OWNER'S THREAD OF A SESSION: the top of its lineage, the conversation the owner talks to.
 *
 * A sub-ferret is named for a piece of work ("Revive Button Flaky"), a callsign ("Vena"). The owner knows the
 * thread that started it, so every Inbox row names that one. The session list already carries `parent`, so the
 * root is found here from the list the app holds, with no request of its own. A parent that is not in the list
 * (pruned) ends the walk at the topmost session that is, and a lineage that loops (it cannot, but a list read
 * mid-write might say so) ends where it first repeats.
 */

import type { SessionView } from '../../contract/index.ts';

/** Each session's root view by session id: a session with no parent in `sessions` is its own root. */
export const rootViews = (sessions: readonly SessionView[]): ReadonlyMap<string, SessionView> => {
  const byId = new Map(sessions.map(view => [view.config.id, view] as const));
  const roots = new Map<string, SessionView>();
  for (const view of sessions) {
    const seen = new Set<string>([view.config.id]);
    let root = view;
    for (;;) {
      const parent = root.config.parent === undefined ? undefined : byId.get(root.config.parent);
      if (parent === undefined || seen.has(parent.config.id)) break;
      seen.add(parent.config.id);
      root = parent;
    }
    roots.set(view.config.id, root);
  }
  return roots;
};
