/**
 * WHAT ACTUALLY HAPPENS AFTER SOMEONE CONFIRMS A BULK STOP. Ported from the
 * `openBulkStop` / `confirmBulkStop` half of kteam
 * `ui/src/components/AgentSidebar.tsx`.
 *
 * This is the most destructive action in the app and it is two taps from a row
 * menu, so the sweep is deliberately paranoid:
 *
 *   - It RE-LISTS the fleet after the confirmation, because eligibility is a
 *     live fact and the dialog may have been open for a while. A refresh that
 *     fails stops the whole sweep — nothing is killed on the strength of a list
 *     that could not be read.
 *   - It then intersects the fresh eligibility with the EXACT ids the reader saw
 *     and agreed to. A session that started matching while the dialog was open is
 *     reported afterwards and needs its own deliberate confirmation; it is never
 *     swept in on the back of consent given for a different list.
 *   - A confirmed target that has since become ineligible is reported as such
 *     rather than silently dropped, so the outcome list accounts for every name
 *     the reader read.
 *
 * It lives apart from the sidebar component because none of the above is a
 * rendering concern, and a destructive sweep deserves assertions that do not go
 * through a browser.
 *
 * WHAT CHANGED — the single-daemon assumption. kteam called `api.listSessions()`
 * and `api.stop(id, …)` against one implicit backend. Every call here takes the
 * `DaemonConnection` the confirmation belongs to, so a sweep can only ever reach
 * the daemon whose fleet was named in the dialog.
 */

import type { SessionView } from '@ferretry/protocol';
import { type BulkStopOutcome, type BulkStopRequest, bulkStopReason } from './agent-sidebar-model.ts';
import { stopTargetName } from './bulk-stop-confirmation.tsx';
import { type StopScope, selectLiveDescendants, selectStopTargets } from './stop-actions.ts';

export interface BulkStopApi<Daemon> {
  /** Re-read this daemon's fleet. Never a cached snapshot: eligibility is live. */
  listSessions(daemon: Daemon): Promise<readonly SessionView[]>;
  stop(daemon: Daemon, sessionId: string, reason: string): Promise<SessionView>;
}

export interface BulkStopRunDeps<Daemon> {
  readonly api: BulkStopApi<Daemon>;
  readonly daemon: Daemon;
  /** Feed every fresh view back into the daemon's fleet slice as it arrives. */
  readonly onUpsert: (view: SessionView) => void;
}

/** The mutable half of a request: what a completed (or failed) run produces. */
export type BulkStopRunResult = Pick<BulkStopRequest, 'running' | 'outcomes' | 'newTargets' | 'newOrphanedDescendants'>;

const failureDetail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Builds the request a confirmation dialog is opened with.
 *
 * Returns `null` for a label sweep on a session that carries no label: a scope
 * that could match nothing is worse than absent, and the caller must not open a
 * dialog it cannot honestly describe.
 */
export const bulkStopRequest = (
  sessions: readonly SessionView[],
  selectedId: string,
  scope: StopScope,
  token: number,
  targets?: readonly SessionView[],
): BulkStopRequest | null => {
  const selected = sessions.find(view => view.config.id === selectedId);
  const labelIdentity = scope === 'label' ? selected?.config.label : undefined;
  if (scope === 'label' && !labelIdentity?.trim()) return null;
  return {
    token,
    selectedId,
    scope,
    ...(labelIdentity ? { labelIdentity } : {}),
    targets: targets ?? selectStopTargets(sessions, selectedId, scope),
    ...(scope === 'orphan' ? { orphanedDescendants: selectLiveDescendants(sessions, selectedId) } : {}),
  };
};

/**
 * Executes one confirmed sweep and reports what happened to every name the
 * reader saw, plus anything that became a target while they were reading.
 *
 * Deliberately returns the next state instead of writing it: the caller owns the
 * run token, and only it can tell whether this result still belongs to the
 * confirmation currently on screen.
 */
export const runBulkStop = async <Daemon>(
  deps: BulkStopRunDeps<Daemon>,
  request: BulkStopRequest,
): Promise<BulkStopRunResult> => {
  const { api, daemon, onUpsert } = deps;

  let fresh: readonly SessionView[];
  try {
    fresh = await api.listSessions(daemon);
    for (const view of fresh) onUpsert(view);
  } catch (cause) {
    // Nothing is stopped on the strength of a list that could not be read.
    return {
      running: false,
      outcomes: [{ id: 'refresh-failed', name: 'Fleet refresh', ok: false, detail: failureDetail(cause) }],
    };
  }

  const confirmedIds = new Set(request.targets.map(view => view.config.id));
  const currentTargets = new Map(
    selectStopTargets(fresh, request.selectedId, request.scope)
      .filter(view => confirmedIds.has(view.config.id))
      .map(view => [view.config.id, view] as const),
  );

  const outcomes: BulkStopOutcome[] = [];
  for (const confirmed of request.targets) {
    const target = currentTargets.get(confirmed.config.id);
    if (!target) {
      outcomes.push({
        id: confirmed.config.id,
        name: stopTargetName(confirmed),
        ok: false,
        detail: 'No longer eligible after refresh; not stopped',
      });
      continue;
    }
    try {
      onUpsert(await api.stop(daemon, target.config.id, bulkStopReason(request)));
      outcomes.push({ id: target.config.id, name: stopTargetName(target), ok: true });
    } catch (cause) {
      outcomes.push({
        id: target.config.id,
        name: stopTargetName(target),
        ok: false,
        detail: failureDetail(cause),
      });
    }
  }

  let newTargets: readonly SessionView[] = [];
  let newOrphanedDescendants: readonly SessionView[] = [];
  try {
    const after = await api.listSessions(daemon);
    for (const view of after) onUpsert(view);
    if (request.scope === 'orphan') {
      const alreadyListed = new Set((request.orphanedDescendants ?? []).map(view => view.config.id));
      newOrphanedDescendants = selectLiveDescendants(after, request.selectedId).filter(
        view => !alreadyListed.has(view.config.id),
      );
    } else {
      newTargets = selectStopTargets(after, request.selectedId, request.scope).filter(
        view => !confirmedIds.has(view.config.id),
      );
    }
  } catch (cause) {
    outcomes.push({ id: 'rescan-failed', name: 'Fleet re-scan', ok: false, detail: failureDetail(cause) });
  }

  return { running: false, outcomes, newTargets, newOrphanedDescendants };
};
