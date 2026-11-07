import type { StatePort } from '@ferretry/kernel/contract';
import type { SessionTransferPlan } from '../../../contract/transfer.ts';
import { TransferPlanFiles } from '../../../contract/transfer-state.ts';
import type { SessionId } from '../../lib/session-id.ts';

/** How `FileSessionTransferTargetPlanStore.install` resolved a target plan copy. */
export interface TransferInstallOutcome {
  readonly status: 'installed' | 'present';
  readonly plan: SessionTransferPlan;
}

/** The one way a target session is refused a plan: it already belongs to another transfer. */
export type SessionTransferPlanConflictKind =
  /** A different plan id already claims this target session: a session is created by one transfer. */
  'session_claimed';

/** Raised where a target session is asked to adopt a second plan. */
export class SessionTransferPlanConflictError extends Error {
  constructor(
    readonly planId: string,
    readonly conflict: SessionTransferPlanConflictKind,
    message: string,
  ) {
    super(message);
    this.name = 'SessionTransferPlanConflictError';
  }
}

/** Raised when a plan document exists but no longer parses as a valid record. */
export class SessionTransferPlanCorruptError extends Error {
  constructor(cause: unknown) {
    super('the persisted transfer plan could not be parsed; the durable anchor is corrupt', { cause });
    this.name = 'SessionTransferPlanCorruptError';
  }
}

/** Stable JSON: object keys sorted recursively, so two equal values serialise alike regardless of construction path. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

/**
 * The target-local transfer persistence, with no global receipt capability.
 *
 * Forks already have one authoritative daemon-global CAS receipt in
 * `FileSessionForkReceiptStore`. Their binder needs only the exact plan copy beneath the reserved
 * target, so production composition cannot accidentally write a
 * second receipt through an invented path.
 *
 * THE FILE MECHANICS ARE THE STATE PORT'S. It writes the document atomically, flushes it and its name, serialises
 * every update of one file on one chain, and refuses to write over a document it found damaged. What this class
 * keeps is the decision: which plan a target may hold, and that an exact replay is made durable again.
 */
export class FileSessionTransferTargetPlanStore {
  constructor(private readonly state: StatePort) {}

  /**
   * Installs one parsed plan beneath the target, idempotently and without a receipt write.
   *
   * An exact visible replay leaves the document's content untouched but REWRITES it through the port before
   * returning `present`: visibility can outlive a process whose write was not yet durable across host power loss,
   * and the port is the only thing that can make a name durable. Conflicts and corrupt documents write nothing
   * and are never rewritten here.
   */
  async install(targetId: SessionId, plan: SessionTransferPlan): Promise<TransferInstallOutcome> {
    let outcome: TransferInstallOutcome | undefined;
    // One serialised read-modify-write: the comparison and the write cannot be separated by another installer.
    const updated = await this.state.update(
      TransferPlanFiles,
      current => {
        if (current === undefined) {
          outcome = { status: 'installed', plan };
          return plan;
        }
        if (current.planId !== plan.planId) {
          throw new SessionTransferPlanConflictError(
            plan.planId,
            'session_claimed',
            `target session already holds plan ${JSON.stringify(current.planId)}, not ${JSON.stringify(plan.planId)}: a session is created by one transfer`,
          );
        }
        if (canonicalJson(current) !== canonicalJson(plan)) {
          throw new SessionTransferPlanConflictError(
            plan.planId,
            'session_claimed',
            `target session already holds a different frozen plan under id ${JSON.stringify(plan.planId)}: replay must install the exact receipt-owned plan`,
          );
        }
        outcome = { status: 'present', plan: current };
        // A distinct value, so the port writes it again (returning `current` itself would decline the write).
        return { ...current };
      },
      targetId,
    );
    if (!updated.ok) throw new SessionTransferPlanCorruptError(updated.error);
    if (outcome === undefined) throw new Error('the transfer plan update ran no decision');
    return outcome;
  }

  /** The parsed plan beneath the target, or `undefined` when none was installed. */
  async load(targetId: SessionId): Promise<SessionTransferPlan | undefined> {
    const read = await this.state.read(TransferPlanFiles, targetId);
    if (!read.ok) throw new SessionTransferPlanCorruptError(read.error);
    return read.value;
  }
}
