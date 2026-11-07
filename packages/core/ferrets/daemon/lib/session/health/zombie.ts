import { instantMs } from '../../warden/time.ts';
import type { SessionHealthSettings } from './settings.ts';

/** What can be observed about a session that has already been declared finished. */
export interface TerminalSessionActivity {
  readonly id: string;
  /** When the session was declared finished. Absent on a terminal record that never stamped one. */
  readonly finishedAt?: string | undefined;
  /** Last modification of the session journal, in wall milliseconds. Absent when there is no file. */
  readonly journalModifiedMs?: number | undefined;
}

/**
 * Whether a finished session is still doing work.
 *
 * The shape is "done-marked but still writing events": the pane is gone, so nothing supervises it
 * and no process listing shows it, yet its journal keeps growing. The grace period is what separates
 * that from the ordinary trailing writes of a session that has only just finished.
 *
 * Every unusable observation answers false. This is the one place in the slice where suspicion is
 * the WRONG default: a zombie verdict re-adopts the session under a fresh monitor, and re-adopting
 * on a garbled timestamp would restart monitors over dead panes on every pass.
 */
export function journalOutlivedTerminal(activity: TerminalSessionActivity, settings: SessionHealthSettings): boolean {
  const finishedMs = instantMs(activity.finishedAt);
  const modifiedMs = activity.journalModifiedMs;
  if (finishedMs === undefined || modifiedMs === undefined || !Number.isFinite(modifiedMs)) return false;
  return modifiedMs - finishedMs >= settings.terminalActivityGraceMs;
}

/** The terminal sessions whose journals outlived them, in the order observed. */
export function detectZombies(
  activity: readonly TerminalSessionActivity[],
  settings: SessionHealthSettings,
): readonly string[] {
  return activity.filter(item => journalOutlivedTerminal(item, settings)).map(item => item.id);
}
