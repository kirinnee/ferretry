/**
 * v4 Gate files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `api-token`, `api-warden-token` at the HOME ROOT (`packages/daemon/src/adapters/api/state-api-credentials.ts:67-68`):
 *   the admin and warden bearer tokens, raw text (32 random bytes base64url + `\n`), `0600`. SECRET: moved, never opened.
 * - `state/audit.jsonl`, `audit.1.jsonl` (the general store and its rotated half), `audit-kept.jsonl`,
 *   `audit-kept.1.jsonl` (the kept store) (`adapters/audit/file-audit-journal.ts:19-24`): one `AuditRecord` per line,
 *   `{at, event, actor, subject?, outcome, detail?}`, NO version (`packages/protocol/src/lib/audit.ts:238`). Names and
 *   ids only. A line that does not parse is counted as unreadable by v4, never shown.
 * - `state/grant-audit.jsonl`, `state/security-audit.jsonl` (`adapters/grants/runtime-grant-ports.ts:72-100`,
 *   `JournalGrantAudit`, never rotated): `{kind, at, actor, changes}`, `kind` `grant.changed` / `security.changed`
 *   (and `device.key-rotated` in the security journal, `bin/fyd.ts:8628`); `actor` a string — `admin-cli`, `admin-ui`,
 *   `device:<id>`, `device`, `warden[:<sid>]` or `peer:<sid>` (`lib/api/actor.ts`) — and `changes` a list of
 *   `capability.axis=on|off` / `setting=value` strings.
 */
import { z } from 'zod';
import { isRecord } from './documents.ts';

export const V4_ADMIN_TOKEN = 'api-token';
export const V4_WARDEN_TOKEN = 'api-warden-token';
/** In the order a reader meets them in time: each rotated half before its live file. */
export const V4_AUDIT_FILES = [
  'state/audit.1.jsonl',
  'state/audit.jsonl',
  'state/audit-kept.1.jsonl',
  'state/audit-kept.jsonl',
] as const;
export const V4_GRANT_JOURNAL = 'state/grant-audit.jsonl';
export const V4_SECURITY_JOURNAL = 'state/security-audit.jsonl';

/** v4's closed `AUDIT_EVENTS` (bb89d054d `packages/protocol/src/lib/audit.ts`), verbatim. */
export const V4_AUDIT_EVENTS = [
  'device.paired',
  'device.revoked',
  'device.expired',
  'pairing.code-minted',
  'pairing.refused',
  'session.opened',
  'step-up.succeeded',
  'step-up.failed',
  'passkey.registered',
  'terminal.opened',
  'terminal.closed',
  'terminal.input',
  'fleet.configured',
  'grants.changed',
  'secrets.used',
  'secrets.changed',
  'catalog.changed',
  'catalog.exported',
  'catalog.share.minted',
  'catalog.share.ended',
  'catalog.member.joined',
  'catalog.member.passkey-added',
  'catalog.member.unlocked',
  'catalog.member.join-refused',
  'catalog.member.join-proved',
  'catalog.member.join-proof-refused',
  'catalog.member.new-passkey-used',
  'catalog.share.new-passkey-marked',
  'catalog.share.new-passkey-cleared',
  'catalog.member.revoked',
  'catalog.member.key-removed',
  'catalog.member.catalog-removed',
  'catalog.member.renamed',
  'catalog.share.cross-member',
  'catalog.link.minted',
  'catalog.link.copied',
  'catalog.link.ended',
  'catalog.link.moved',
  'catalog.link.changed',
  'catalog.link.revived',
  'security.changed',
  'device.key-rotated',
  'pairing.code-revoked',
  'push.changed',
  'warden.configured',
  'warden.ran',
  'browser.opened',
  'browser.proxy-tested',
  'worktree.removed',
  'agent.prompted',
  'agent.tool',
  'surface.control',
  'input.requested',
  'input.delivered',
  'input.refused',
  'input.rebound',
  'input.expired',
  'input.cancelled',
  'input.quarantine_ended',
  'input.quarantine_revealed',
  'link.opened',
  'session.credential-refused',
  'session.credential-revoked',
  'phone-approval.raised',
  'phone-approval.refused',
  'phone-approval.settled',
] as const;

/**
 * The v4 kinds v5 renamed (`packages/core/gate/contract/policy.ts` `AUDIT_KIND_NAMES`: "hold" replaces "quarantine",
 * a ferret's credential is the ferret's). Every other v4 kind keeps its name.
 */
export const V4_AUDIT_RENAMES: Readonly<Record<string, string>> = {
  'input.quarantine_ended': 'input.hold-ended',
  'input.quarantine_revealed': 'input.hold-revealed',
  'session.credential-refused': 'ferret.credential-refused',
  'session.credential-revoked': 'ferret.credential-revoked',
};

/** The v5 kind of a v4 audit record's event, or `undefined` when v4 never wrote that event. */
export function v5AuditKind(event: unknown): string | undefined {
  if (typeof event !== 'string' || !(V4_AUDIT_EVENTS as readonly string[]).includes(event)) return undefined;
  return V4_AUDIT_RENAMES[event] ?? event;
}

/** v4's `readAuditLine`: a journal line, or `undefined` when it is not a record v4 would have read. */
export const V4JournalLine = z.object({
  kind: z.string().min(1),
  at: z.string().min(1),
  actor: z.string().min(1),
  changes: z.array(z.string()),
});
export type V4JournalLine = z.infer<typeof V4JournalLine>;

/** Each journal's kinds, and the v5 audit kind each becomes (`grant.changed` was always v4's `grants.changed`). */
export const V4_JOURNAL_KINDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [V4_GRANT_JOURNAL]: { 'grant.changed': 'grants.changed' },
  [V4_SECURITY_JOURNAL]: { 'security.changed': 'security.changed', 'device.key-rotated': 'device.key-rotated' },
};

/**
 * A journal's actor string as v5's audit actor: the admin token (CLI or app) is someone at the machine (`host`), a
 * device keeps its id, a warden is a warden. A ferret's own credential (`peer:<sid>`) and anything else has no v5
 * actor kind: `undefined`.
 */
export function v5JournalActor(actor: string): { kind: 'host' | 'device' | 'warden'; deviceId?: string } | undefined {
  if (actor === 'admin-cli' || actor === 'admin-ui') return { kind: 'host' };
  if (actor === 'device') return { kind: 'device' };
  if (actor.startsWith('device:') && actor.length > 'device:'.length)
    return { kind: 'device', deviceId: actor.slice('device:'.length) };
  if (actor === 'warden' || actor.startsWith('warden:')) return { kind: 'warden' };
  return undefined;
}

/** One line of a JSONL file as a JSON object, or `undefined` for a torn or foreign line. */
export function jsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
