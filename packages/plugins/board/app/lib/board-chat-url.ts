/**
 * THE TASKS TAB'S PLACE IN THE ADDRESS: whether the ferret's board fills the chat, and whether it shows agent
 * tasks. Both ride the chat's own URL, so a link or a reload lands on the same view and the browser's Back
 * collapses a board that was expanded.
 *
 * `agents` is the Board page's own parameter ({@link AGENTS_PARAM}), read and written by one rule; `tasks=full`
 * is the expansion. Everything else in the query (an agenda target, a highlight) is left exactly as it was.
 */

import { AGENTS_PARAM } from './board-model.ts';

const TASKS_PARAM = 'tasks';
const FULL = 'full';

export interface ChatTasksUrl {
  /** The board fills the whole chat area instead of sitting in the Info panel. */
  readonly expanded: boolean;
  /** "Show private" is on. */
  readonly agents: boolean;
}

/** What a query string says about the Tasks tab; anything it does not know is the plain panel. */
export const readChatTasksUrl = (search: string): ChatTasksUrl => {
  const params = new URLSearchParams(search);
  return { expanded: params.get(TASKS_PARAM) === FULL, agents: params.get(AGENTS_PARAM) === '1' };
};
