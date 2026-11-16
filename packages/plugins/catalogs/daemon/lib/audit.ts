import type { AuditActor, AuditDetail, AuditOutcome } from '@ferretry/core-gate/contract';
/** Today's catalog audit emitter shape; the Gate adapter binds event names to policy refs. */
export interface AuditEntry {
  readonly event: string;
  readonly actor: AuditActor;
  readonly cause?: 'daemon';
  readonly subject?: string;
  readonly outcome: AuditOutcome;
  readonly detail?: AuditDetail;
}
