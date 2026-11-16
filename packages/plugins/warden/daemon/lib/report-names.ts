/**
 * Whose report a file is, from the name the daemon gave it alone.
 *
 * The daemon names an assigned report `<instant>-<session-id>.md`; a fleet-triage report is `<instant>.md`. A scoped
 * scan uses the name to skip, unopened, a report that is about a ferret outside the lineage, so what such a report holds
 * (or whether it can be read at all) cannot change what the scope is told. The NAME is the daemon's, not a model's.
 */

/** Session id embedded in an assigned report filename `<instant>-<sessionId>.md`. */
const FILENAME_SESSION = /Z-([a-z0-9]+-[0-9a-f]{6,})\.md$/i;

/** The session an assigned report is FOR, from its file name; `undefined` for a fleet-triage report (`<instant>.md`). */
export function reportNamedFor(path: string): string | undefined {
  return FILENAME_SESSION.exec(path)?.[1];
}
