/**
 * The chat's Tasks tab as the address says it: expanded or not, agent tasks shown or not (`board-chat-url.ts`).
 *
 * Expanding PUSHES an entry, so the browser's Back collapses the board. Collapsing steps back over that entry
 * when it is the one before this and "Internal" has not changed since (then the page returns exactly
 * as it was); otherwise it rewrites the entry in place, so a choice made while expanded survives the collapse.
 * "Internal" REPLACES the entry: it is a way of looking at the same page, not a place to come back to.
 */

import { useMemo, useRef, useState } from 'react';
import { type ChatTasksView, readChatTasksUrl, withChatTasksUrl } from '../lib/board-chat-url.ts';
import type { RouterController } from '../lib/router.tsx';

export const useChatTasksUrl = (
  router: Pick<RouterController, 'navigate' | 'back'>,
  location: { readonly pathname: string; readonly search: string },
): ChatTasksView => {
  const { navigate, back } = router;
  const { pathname, search } = location;
  const agentsWhenExpanded = useRef<boolean | null>(null);
  return useMemo(() => {
    const now = readChatTasksUrl(search);
    return {
      ...now,
      setExpanded: expanded => {
        const to = `${pathname}${withChatTasksUrl(search, { expanded })}`;
        if (expanded) {
          agentsWhenExpanded.current = now.agents;
          navigate(to);
        } else if (agentsWhenExpanded.current === null || agentsWhenExpanded.current === now.agents) {
          back(to);
        } else {
          navigate(to, { replace: true });
        }
      },
      setAgents: agents => navigate(`${pathname}${withChatTasksUrl(search, { agents })}`, { replace: true }),
    };
  }, [navigate, back, pathname, search]);
};

/** The same view kept in state, for a page not wired to an address (a harness, a host with no router). */
export const useStateChatTasks = (): ChatTasksView => {
  const [expanded, setExpanded] = useState(false);
  const [agents, setAgents] = useState(false);
  return useMemo(() => ({ expanded, agents, setExpanded, setAgents }), [expanded, agents]);
};
