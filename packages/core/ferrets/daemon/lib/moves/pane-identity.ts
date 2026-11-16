import type { RunnerPaneIdentity } from '../../../contract/index.ts';

/**
 * The string a rollback compares to decide whether the pane serving now is the one that served before a failed relaunch.
 *
 * It is `undefined` (UNKNOWN) unless the runner named all three of the handle, the root pid and the root's start: a pane
 * with a missing pid or start would otherwise key as `%3::` for every such pane, and two unknowns would read as the same
 * pane, putting a config back over a harness that did change. A caller treats `undefined` as "cannot prove it is the same".
 */
export function paneIdentityKey(identity: RunnerPaneIdentity | 'gone' | undefined): string | undefined {
  if (identity === undefined || identity === 'gone') return undefined;
  if (identity.pid === undefined || identity.processStart === undefined) return undefined;
  return `${identity.handle}:${String(identity.pid)}:${identity.processStart}`;
}
