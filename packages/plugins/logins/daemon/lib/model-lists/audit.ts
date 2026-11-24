import { type AuditDraft, auditKind } from '@ferretry/core-gate/contract';

/**
 * What one read of a login's model list did with the login's key, as the Vault's `authorizeFetch` placed it on one
 * request. The note has no field for a value, a header, a URL path or a reply, so none can reach the log.
 */
export interface ModelListReadNote {
  readonly loginId: string;
  /** The secret's NAME (`DEEPSEEK_API_KEY`), never its value. */
  readonly secret: string;
  /** The one host the key was sent to. */
  readonly host: string;
  /** The outcome's kind (`completion`, `status`, `timeout`, `unreachable`, …). */
  readonly outcome: string;
}

/**
 * The `secrets.used` record of one list read (docs/audit.md, the same shape `kernel.secrets.send` leaves): subject the
 * secret's name, detail the plugin, the host and the outcome's kind, plus the login id. The machine spent the key on a
 * person's behalf (a picker, "Refresh list", an edit), so the actor is this computer and the cause the daemon's. A reply
 * that came back, with any status, is a send that succeeded; only a send that got none failed.
 */
export function modelListReadDraft(note: ModelListReadNote): AuditDraft {
  return {
    event: auditKind('secrets.used'),
    actor: { kind: 'host' },
    subject: note.secret,
    outcome: note.outcome === 'completion' || note.outcome === 'status' ? 'succeeded' : 'failed',
    detail: { plugin: 'logins', login: note.loginId, host: note.host, outcome: note.outcome },
    cause: 'daemon',
  };
}
