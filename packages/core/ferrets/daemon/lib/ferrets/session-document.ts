import type { FerretDetails, FerretRecord, FerretState } from '../../../contract/index.ts';
import type { SessionConfig } from '../protocol/session.ts';
import type { SessionStatus } from '../protocol/session-base.ts';
import { reviveRuling } from '../protocol/session-revive.ts';

/**
 * The supervision fields today's start wrote into every session document it made (today's `SESSION_START_DEFAULTS`,
 * word for word). No retry is attempted because no supervisor exists to attempt one; a policy claiming otherwise would
 * be read as a guarantee by every surface that displays it.
 */
const SESSION_DOCUMENT_DEFAULTS = {
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 0,
  killAfterSeconds: 0,
  directSendMaxChars: 4_096,
  resumeMenuChoice: 'full',
  maxSnapshots: 10,
  retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
} as const satisfies Partial<SessionConfig>;

/** What a ferret's session document is made from: its record, its start options, and the turns it already holds. */
export interface SessionDocumentSeed {
  readonly record: FerretRecord;
  readonly details?: FerretDetails | undefined;
  /** The highest turn document already on disk for the ferret (0 when none): the counter a revive numbers after. */
  readonly turn: number;
}

/** The session-status word a ferret's lifecycle state is read as (the same reading the signal adapter makes). */
function sessionStatusOf(state: FerretState): SessionStatus {
  switch (state) {
    case 'starting':
      return 'starting';
    case 'working':
      return 'running';
    case 'idle':
      return 'awaiting_user';
    case 'stopped':
      return 'stopped';
  }
}

/** Statuses of a session on its way up: made, starting, or being retried. */
const ON_ITS_WAY_UP: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['created', 'starting', 'retrying']);

/**
 * The session status a ferret's state document moves to when its LIFECYCLE moves (U4), or `undefined` to leave it: the
 * document is made once with the status of that moment (`starting`), and today's lifecycle moved it to `running` when
 * the launch settled and to `stopped` at a stop. Only those edges are followed. A turn (`working` ↔ `idle`) is the
 * turn watch's `turnState`, never a status, and a status something else decided on a live session (`rate_limited`,
 * `awaiting_question`, …) is left as it is — except by a stop, which ends every live one.
 *
 * A REVIVE brings the document back from every status the one revive rule (`reviveRuling`, behind every Resume button)
 * calls revivable — `stopped`, `completed`, `failed`, `stalled` — as today's resume set `starting` from each
 * (`R/src/lib/session/resume/service.ts:232`); left there, the ferret would never be watched again. It needs PROOF of a
 * new live run: the registry's own start edge (`cause: 'lifecycle'`, state `starting`: a start, a resume or a fork's
 * launch writes it before anything is launched). A plain turn edge (`working` / `idle`) never revives an ended document,
 * and neither does a reconcile (`cause: 'reconcile'`, a registry read at arm that may be stale): a failure the lifecycle
 * wrote stays failed. `kill_failed` is NEVER moved by these edges (today's transition table lets it go only to
 * `stopped`): it says a stop was not confirmed, and no registry edge confirms one, so clearing it would erase the only
 * record that an old pane may still be alive. Pure.
 */
export function lifecycleStatus(
  current: SessionStatus,
  state: FerretState,
  cause: 'lifecycle' | 'reconcile' = 'lifecycle',
): SessionStatus | undefined {
  if (current === 'kill_failed') return undefined;
  const ended = reviveRuling(current).revivable;
  switch (state) {
    case 'starting':
      return ended && cause === 'lifecycle' ? 'starting' : undefined;
    case 'working':
    case 'idle':
      return ON_ITS_WAY_UP.has(current) ? 'running' : undefined;
    case 'stopped':
      return ended ? undefined : 'stopped';
  }
}

/**
 * THE SESSION DOCUMENT (`config.json`) of a ferret Ferrets' own service starts, as today's start made it (ruling #31b):
 * who the ferret is, where it works, its lineage and label, its harness and model, and today's supervision defaults.
 * WHO CAUSED IT (the provenance stamp) is not here: the stamper merges it in right after, as today's start did.
 *
 * An incarnation names one RUN of a session, and this is the session's first that the document records. `agent` is the
 * runtime the ferret runs on (the name every surface displays), else its harness.
 */
export function sessionDocument(seed: SessionDocumentSeed, now: string): SessionConfig {
  const { record } = seed;
  const options = seed.details?.options;
  return {
    id: record.id,
    incarnation: `${record.id}-1`,
    runtimeGeneration: 1,
    name: record.name,
    teammate: record.name,
    ...(options?.label === undefined ? {} : { label: options.label }),
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    agent: record.runtime ?? record.harness,
    harness: record.harness === 'codex' ? 'codex' : 'claude',
    modelHint: options?.model ?? '',
    ...(options?.model === undefined ? {} : { model: options.model, launchModelSource: 'requested' as const }),
    ...(options?.effort === undefined ? {} : { launchReasoningEffort: options.effort }),
    ...(options?.fast === undefined ? {} : { launchFast: options.fast }),
    mode: record.mode ?? 'auto',
    remoteControl: false,
    harnessFlags: [...(options?.harnessFlags ?? [])],
    cwd: record.folder,
    createdAt: record.createdAt,
    updatedAt: now,
    turn: seed.turn,
    ...SESSION_DOCUMENT_DEFAULTS,
    retry: { ...SESSION_DOCUMENT_DEFAULTS.retry },
  };
}

/**
 * The state document (`state.json`) made beside it: the session's id, the status its lifecycle state reads as when the
 * document is made, and the turn counter. Ferrets' registry stays the ONE owner of the ferret's state; what a reader of
 * this document may rely on is the turn a revive numbers after.
 */
export function sessionStateDocument(seed: SessionDocumentSeed): {
  readonly id: string;
  readonly status: SessionStatus;
  readonly turn: number;
} {
  return { id: seed.record.id, status: sessionStatusOf(seed.record.state), turn: seed.turn };
}

/**
 * The state document after its status moved to `next` (U6): a ferret that STOPS is stamped with when it ended
 * (`finishedAt`, which the session archive measures its age from, as today's lifecycle stamped it), and one that starts
 * again drops that stamp, so a revived ferret never carries an old end. Any other status leaves the stamp as it is.
 * Pure; the document's other keys are kept as they are.
 */
export function withLifecycleStatus(
  document: Readonly<Record<string, unknown>>,
  next: SessionStatus,
  now: string,
): Readonly<Record<string, unknown>> {
  if (next === 'stopped') return { ...document, status: next, finishedAt: now };
  const { finishedAt: _ended, ...kept } = document;
  return next === 'starting' || next === 'running' ? { ...kept, status: next } : { ...document, status: next };
}
