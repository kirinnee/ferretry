/**
 * WHICH SESSION ACTIONS A ROW OFFERS. Ported from kteam
 * `ui/src/lib/session-actions.ts`.
 *
 * This is pure data, not a component, precisely so the fleet sidebar's row
 * context menu and the session header's inline controls agree BY CONSTRUCTION
 * rather than by two hand-kept copies that drift. It decides availability only —
 * it never performs an action and never bypasses a confirmation. Migrate stays a
 * sheet with its own in-flight warning; this merely surfaces the entry point.
 *
 * WHAT CHANGED — survey row #4. kteam gated every action on `HAS_TOKEN`, a
 * module global captured once when `lib/api` evaluated (`src/lib/api.ts:27-37`),
 * so the whole tab shared one backend's authority. A browser here is paired with
 * several daemons at once, so the authority is a property of the CONNECTION the
 * row belongs to and arrives as a parameter. There is deliberately no ambient
 * fallback: a caller that cannot name a daemon cannot render an action for it.
 */

import type { SessionStatus, SessionView } from '@ferretry/protocol';
import { TERMINAL_STATUSES } from './status-mark.tsx';

export type SessionAction = 'interrupt' | 'stop' | 'resume' | 'rename' | 'migrate';

export interface SessionActionSpec {
  readonly action: SessionAction;
  readonly label: string;
  /**
   * Destructive tone for Stop and Migrate (relaunch) — the two that discard or
   * interrupt work.
   */
  readonly danger?: boolean;
}

/**
 * `kill_failed` is terminal (nothing will move this session again, which is why
 * `status-mark` counts it) yet it is the one terminal status that still needs
 * Stop — the previous stop is what failed. It is called out rather than folded
 * into "terminal" because the two questions genuinely differ.
 */
const isKillFailed = (status: SessionStatus): boolean => status === 'kill_failed';

/**
 * The ordered actions for a session row's context menu. Empty when the caller's
 * connection may not mutate, exactly as the header hides every control there.
 *
 *   Interrupt — a running (non-terminal) session only.
 *   Resume    — a finished session that did not fail to die.
 *   Stop      — anything still running, plus a `kill_failed` session (Stop again).
 *   Rename    — always available.
 *   Migrate   — always available; opens the destructive sheet.
 */
export const sessionActionSpecs = (view: SessionView, canMutate: boolean): readonly SessionActionSpec[] => {
  if (!canMutate) return [];
  const status = view.state.status;
  const terminal = TERMINAL_STATUSES.has(status);
  const killFailed = isKillFailed(status);

  const specs: SessionActionSpec[] = [];
  if (!terminal) specs.push({ action: 'interrupt', label: 'Interrupt turn' });
  if (terminal && !killFailed) specs.push({ action: 'resume', label: 'Resume session' });
  if (!terminal || killFailed) specs.push({ action: 'stop', label: 'Stop session', danger: true });
  specs.push({ action: 'rename', label: 'Rename…' });
  specs.push({ action: 'migrate', label: 'Move account + relaunch…', danger: true });
  return specs;
};
