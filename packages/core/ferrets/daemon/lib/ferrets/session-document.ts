import type { FerretDetails, FerretRecord, FerretState } from '../../../contract/index.ts';
import type { SessionConfig } from '../protocol/session.ts';
import type { SessionStatus } from '../protocol/session-base.ts';

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
    ...(options?.model === undefined ? {} : { model: options.model }),
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
