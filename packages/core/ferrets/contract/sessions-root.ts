import { internalRootFolder, type RootName } from '@ferretry/kernel/contract';

/**
 * Where a ferret's private session folder is: ONE fact, owned here, for every reader and writer outside Ferrets that
 * must agree with it (the upgrade from v4 copies each ferret's v4 turns into it).
 *
 * Each ferret has one folder, named by its id, on the kernel's internal `sessions` root, which the kernel places at
 * `<home>/state/<plugin>/<root>` — for Ferrets, `state/ferrets/sessions`. It holds the ferret's environment, its effect
 * ledger, its completion markers and its turn documents: `turns/turn-001.md` (the assigned task, or a transferred
 * ferret's first-turn brief, which is the same document) and every revive's `turns/turn-NNN.md`, each with the record
 * of who it is from beside it as `turns/turn-NNN.by.json`.
 */

/** The kernel root each ferret's session folder is a scoped handle on. */
export const FERRET_SESSIONS_ROOT = 'sessions' satisfies RootName;

/**
 * That root's folder, relative to the Ferretry home: `state/ferrets/sessions` (one `<ferret>` folder below it). Derived
 * from the kernel's own layout ({@link internalRootFolder}), the same fact the kernel makes the base by and the home
 * fence pins it by, so the three can never name two places.
 */
export const FERRET_SESSIONS_FOLDER = internalRootFolder('ferrets', FERRET_SESSIONS_ROOT);

/** The folder of a ferret's turn documents, relative to its own session folder. */
export const FERRET_TURNS_FOLDER = 'turns';

/** A turn document's name, at least three digits: `turn-001.md`, `turn-012.md`, `turn-1000.md`. */
export function ferretTurnFileName(turn: number): string {
  if (!Number.isInteger(turn) || turn < 1) throw new Error(`a turn number is a whole number from one (got ${turn})`);
  return `turn-${String(turn).padStart(3, '0')}.md`;
}

/**
 * The folders of a ferret's OWN session folder its agent is pointed into to read what it was sent (today's
 * `handoffFolders`): its turn documents, its queued messages and the attachments it was started with, relative to that
 * session folder. Never the session folder itself: `environment.json` (the plaintext credential), the effect ledger
 * and the completion markers sit beside these and stay unreadable without asking. A start or a resume hands their
 * absolute paths to the harness as `LaunchSpec.readable`.
 */
export const FERRET_READABLE_FOLDERS = Object.freeze([FERRET_TURNS_FOLDER, 'channel', 'attachments'] as const);

/** A turn document's path relative to its ferret's session folder: `turns/turn-001.md`. */
export function ferretTurnFile(turn: number): string {
  return `${FERRET_TURNS_FOLDER}/${ferretTurnFileName(turn)}`;
}
