import {
  AUDIT_KEPT_KINDS,
  type AuditActor,
  type AuditDetail,
  type AuditDraft,
  type AuditOutcome,
  type AuditRecord,
  AuditRecordSchema,
  type AuthenticatedCredential,
} from '../../../contract/index.ts';

/**
 * The pure decisions of the audit domain (today's `lib/audit/policy.ts`, copied): who a credential is in the log's
 * vocabulary, what a status says about an outcome, what one record looks like, and which repeats fold.
 */

/**
 * Who the log says acted, from the credential admission derived — never from anything the caller sent. The admin
 * token and a ferret's own token are `host` (they are on this machine); a ferret is named in the detail instead.
 */
export function auditActorOf(credential: AuthenticatedCredential | undefined): AuditActor {
  if (credential === undefined) return { kind: 'anonymous' };
  switch (credential.tokenClass) {
    case 'admin':
    case 'ferret':
      return { kind: 'host' };
    case 'warden':
      return { kind: 'warden' };
    case 'device':
      return { kind: 'device', deviceId: credential.principal.holder };
  }
}

/** The detail that names the ferret behind a record its own token caused: `by: 'agent'` and the ferret, never the token. */
export function agentAuditDetail(credential: AuthenticatedCredential | undefined): AuditDetail {
  return credential?.tokenClass === 'ferret' ? { by: 'agent', ferret: credential.ferret } : {};
}

/** What an HTTP status says happened: a 4xx is the daemon refusing, a 5xx or no answer is it failing. */
export function auditOutcomeOf(status: number | undefined): AuditOutcome {
  if (status === undefined || status >= 500) return 'failed';
  return status >= 400 ? 'refused' : 'succeeded';
}

/** One record, stamped and PROVED against the wire contract before anything is written. */
export function auditRecord(entry: AuditDraft, at: string): AuditRecord {
  return AuditRecordSchema.parse({
    format: 1,
    at,
    event: entry.event,
    actor: entry.actor,
    ...(entry.subject === undefined ? {} : { subject: entry.subject }),
    outcome: entry.outcome,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });
}

const isKept = (event: string): boolean => (AUDIT_KEPT_KINDS as readonly string[]).includes(event);

/**
 * Which repeats fold together, or nothing for a record that is never folded (today's `auditFoldKey`). A refusal or a
 * failure folds by who, what, how it ended and the carrier; a successful act of activity folds by who, what, its
 * subject and every detail; a success of a kept kind is never folded.
 */
export function auditFoldKey(entry: AuditDraft): string | undefined {
  const who = `${entry.actor.kind}:${entry.actor.deviceId ?? ''}`;
  if (entry.outcome === 'succeeded') {
    if (isKept(entry.event)) return undefined;
    const detail = Object.entries(entry.detail ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([who, entry.event, entry.subject ?? '', detail]);
  }
  const carrier = typeof entry.detail?.carrier === 'string' ? entry.detail.carrier : '';
  return `${who}|${entry.event}|${entry.outcome}|${carrier}`;
}

/** How many kept records of ONE kind every caller who is not a person at this machine may write per UTC day. */
export const AUDIT_KEPT_DAILY_ALLOWANCE = 50;

/**
 * Whether a kept record is exempt from the allowance and may rotate the kept store: a person at the machine. A record
 * the daemon caused on its own (`cause: 'daemon'`, an idle expiry) is rationed like a remote one.
 */
export function isOwnersOwnRecord(entry: AuditDraft): boolean {
  return entry.actor.kind === 'host' && entry.cause !== 'daemon';
}

/** What stands in for a text field the contract would refuse — never the text itself. */
export const AUDIT_INVALID_TEXT = '<invalid>';
const AUDIT_TEXT = /^[^\p{Cc}\p{Cf}]{1,160}$/u;

/** An entry whose free text is made to fit, so the EVENT is never lost to its own subject (today's `withinAuditBounds`). */
export function withinAuditBounds(entry: AuditDraft): AuditDraft {
  const subjectFits = entry.subject === undefined || AUDIT_TEXT.test(entry.subject);
  const detail: AuditDetail | undefined =
    entry.detail === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(entry.detail).map(([key, value]) => [
            key,
            typeof value !== 'string' || AUDIT_TEXT.test(value) ? value : AUDIT_INVALID_TEXT,
          ]),
        );
  if (subjectFits) return detail === undefined ? entry : { ...entry, detail };
  return { ...entry, subject: AUDIT_INVALID_TEXT, detail: { ...detail, subjectLength: entry.subject?.length ?? 0 } };
}

/**
 * The record one admitted call leaves when its descriptor says `audit: { record }` (today's audited-route decorator,
 * `lib/audit/routes.ts`, reduced to what a descriptor declares): the kind, who acted from the credential admission
 * derived, how it ended from the status, the one path parameter as the subject, and — for a ferret's own token — which
 * ferret. WHAT IT MAY READ IS THE GUARANTEE: never the request body and never the response, so no code, token, key or
 * command line can reach the log. A refusal at admission never reaches a handler and is not recorded here.
 */
export function routeAuditDraft(
  event: AuditDraft['event'],
  call: {
    readonly credential?: AuthenticatedCredential;
    readonly params: ReadonlyMap<string, string>;
    readonly request: { readonly arrival: { readonly kind: 'local' | 'carried'; readonly carrier?: string } };
  },
  status: number | undefined,
): AuditDraft {
  const params = [...call.params.values()];
  const subject = params.length === 1 ? params[0] : undefined;
  const carrier = call.request.arrival.kind === 'carried' ? call.request.arrival.carrier : undefined;
  const detail: AuditDetail = {
    ...agentAuditDetail(call.credential),
    ...(carrier === undefined ? {} : { carrier }),
  };
  return {
    event,
    actor: auditActorOf(call.credential),
    ...(subject === undefined || subject === '' ? {} : { subject }),
    outcome: auditOutcomeOf(status),
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}
