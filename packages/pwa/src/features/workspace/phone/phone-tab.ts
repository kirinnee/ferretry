/**
 * THE PHONE WORKSPACE'S OWN VOCABULARY: what one chip is, which chips always
 * exist, and which shape of workspace a viewport gets.
 *
 * A phone has no splits. Every pane's tabs merge into ONE chip row, led by the
 * two tabs every session always has — Chat and Console — so the descriptor here
 * is deliberately the smallest thing a chip needs. The split workspace keeps its
 * own richer model; the integration maps that onto this, so neither side has to
 * import the other's internals.
 */

import { DRAWER_MAX, RAIL_MAX } from '../../../hooks/use-layout-mode.ts';

export type PhoneTabKind = 'chat' | 'console' | 'processes' | 'terminal' | 'browser' | 'file';

/** Who is driving a tab right now. `null` (or absent) means the human is. */
export interface PhoneTabDriver {
  readonly name: string;
}

export interface PhoneTab {
  readonly id: string;
  readonly kind: PhoneTabKind;
  readonly label: string;
  readonly driver?: PhoneTabDriver | null;
  /** An agent added this tab and the person has not looked at it yet. */
  readonly fresh?: boolean;
  /** The agent handed this tab to the person: it is their turn. */
  readonly asked?: boolean;
  /** A workspace tab the person may close. Chat and Console never are: they are the agent. */
  readonly closable?: boolean;
}

export const PHONE_CHAT_TAB: PhoneTab = { id: 'chat', kind: 'chat', label: 'Chat' };
export const PHONE_CONSOLE_TAB: PhoneTab = { id: 'console', kind: 'console', label: 'Console' };
export const PHONE_PROCESSES_TAB: PhoneTab = { id: 'processes', kind: 'processes', label: 'Processes' };

/**
 * The full chip order: Chat, Console, Processes, then the workspace tabs in the order they
 * were given. A workspace tab that reuses a fixed id is dropped rather than
 * shown twice — two chips with one id would select together.
 */
export const phoneTabOrder = (
  workspaceTabs: readonly PhoneTab[],
  processes: PhoneTab = PHONE_PROCESSES_TAB,
): readonly PhoneTab[] => [
  PHONE_CHAT_TAB,
  PHONE_CONSOLE_TAB,
  processes,
  ...workspaceTabs.filter(
    tab => tab.id !== PHONE_CHAT_TAB.id && tab.id !== PHONE_CONSOLE_TAB.id && tab.id !== PHONE_PROCESSES_TAB.id,
  ),
];

/** Terminal-like tabs get the key bar: a phone keyboard has no esc, tab, ctrl or arrows. */
export const phoneTabTakesKeys = (kind: PhoneTabKind): boolean => kind === 'terminal' || kind === 'console';

/**
 * The neighbour a swipe lands on, or `null` at either end. A swipe never wraps:
 * swiping past Chat to reach the last tab would be a surprise, not a shortcut.
 */
export const adjacentPhoneTab = (
  order: readonly PhoneTab[],
  currentId: string,
  direction: 'next' | 'previous',
): PhoneTab | null => {
  const index = order.findIndex(tab => tab.id === currentId);
  if (index === -1) return null;
  return order[direction === 'next' ? index + 1 : index - 1] ?? null;
};

/**
 * The scroll offset that puts a chip in the middle of its row, clamped to what
 * the row can actually scroll. Pure geometry so it tests without layout.
 */
export const centredScrollLeft = (row: {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly chipLeft: number;
  readonly chipWidth: number;
}): number => {
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  const ideal = row.chipLeft + row.chipWidth / 2 - row.clientWidth / 2;
  return Math.min(max, Math.max(0, Math.round(ideal)));
};

export type WorkspaceFormFactor = 'phone' | 'tablet-split' | 'desktop';

/** Below this SHORT side a landscape screen is a phone on its side, not a tablet. */
export const TABLET_MIN_HEIGHT = 600;

/**
 * Which workspace a viewport gets. Reuses the sidebar's breakpoints so the two
 * never disagree about what a "phone" is.
 *
 *   desktop       >= RAIL_MAX wide: the full split workspace.
 *   phone         narrower than DRAWER_MAX, OR a landscape phone (too short to
 *                 hold two panes), OR a tablet held upright.
 *   tablet-split  a tablet in landscape: two panes, no more.
 */
export const workspaceFormFactor = (width: number, height: number): WorkspaceFormFactor => {
  if (width >= RAIL_MAX) return 'desktop';
  if (width < DRAWER_MAX || height < TABLET_MIN_HEIGHT) return 'phone';
  return width > height ? 'tablet-split' : 'phone';
};
