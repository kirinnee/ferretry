import type { AuditActor, AuditDetail } from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import type { InputAudit, InputAuditEntry, InputSaveAuditEntry } from './ports.ts';

/**
 * Writes an input request's audit record to the daemon's audit log: the event, who acted and names and
 * flags. `detail` is the already-bounded {@link InputAuditEntry} detail plus the request id; there is no
 * field here that could hold a value.
 *
 * An agent has no audit actor kind of its own, so it is recorded as the host the way every agent tool call
 * is, with `by: 'agent'` saying which. The daemon's own act (an expiry) is `cause: 'daemon'`.
 */
export class InputAuditAdapter implements InputAudit {
  constructor(private readonly sink: AuditSink) {}

  async record(entry: InputAuditEntry): Promise<void> {
    const actor: AuditActor = entry.actor.kind === 'device' ? entry.actor : { kind: 'host' };
    const detail: AuditDetail = {
      ...Object.fromEntries(Object.entries(entry.detail).filter(([, value]) => value !== undefined)),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.actor.kind === 'agent' ? { by: 'agent' } : {}),
    };
    await this.sink.record({
      event: entry.event,
      actor,
      subject: entry.sessionId,
      outcome: entry.event === 'input.refused' ? 'refused' : 'succeeded',
      ...(entry.actor.kind === 'daemon' ? { cause: 'daemon' as const } : {}),
      detail,
    });
  }

  /**
   * "Save as" on a card is a change to the secret store, so it is KEPT exactly as `fy secret set` is: event
   * `secrets.changed`, the entry's handle as the subject, and which field — never the value.
   */
  async saved(entry: InputSaveAuditEntry): Promise<void> {
    await this.sink.record({
      event: 'secrets.changed',
      actor: entry.actor.kind === 'device' ? entry.actor : { kind: 'host' },
      subject: entry.entry,
      outcome: 'succeeded',
      detail: { action: 'login-save', field: entry.field, requestId: entry.requestId, session: entry.sessionId },
    });
  }
}
