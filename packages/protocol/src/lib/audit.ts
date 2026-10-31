import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/**
 * THE SECURITY AUDIT LOG, as the wire describes it.
 *
 * One record per thing that changed WHO may reach this machine or WHAT they did with the access they
 * were given: a device paired or revoked, a code minted, a pairing refused, a grant moved, the fleet
 * reconfigured, a terminal opened, a secret used. It exists so "which phone was paired last Tuesday,
 * and what has it done since" has an answer that does not depend on somebody having been watching.
 *
 * ## NAMES AND IDS ONLY — AND THE SCHEMA IS WHERE THAT IS ENFORCED
 *
 * An append-only file outlives every credential mentioned in it, so a record that carried a code, a
 * token, a key, a proof, a secret value or a command line would turn the audit trail into the most
 * valuable file on the machine. Every free-text field below is BOUNDED and the `detail` map holds
 * short scalar facts only, so there is no field a caller could hand a command line or a blob to and
 * have it fit. What a field may NAME is the emitter's job, and the daemon's tests grep every written
 * record for each fixture secret to prove the emitters keep it.
 *
 * ## THE EVENT LIST IS CLOSED
 *
 * Every kind here is emitted by the daemon; a new kind is a change to this list, so a reader's word
 * table fails typecheck until it says what the new kind means. `security.changed` names the setting as
 * its subject, and its detail holds only numbers and booleans — the settings as they stand after the
 * change — never text a person typed. `device.expired` is the daemon's own idle expiry.
 *
 * `terminal.input` is keystrokes reaching a terminal, FOLDED: one record per terminal per window
 * carrying how many frames arrived, never what they said. The rest name the act on the route that
 * performs it — a secret put or deleted, a pairing code withdrawn, a push enrolment added or removed,
 * the warden reconfigured or run, a browser opened or attached, a worktree removed. `session.opened` is
 * an agent session started or forked, and `agent.prompted` a message or an answer handed to one: an
 * agent in auto mode runs commands, so "which device told it what to do" belongs to this history. Both
 * are activity, folded per device and session per window. `agent.tool` is one agent tool call on a
 * terminal or browser page, named by tool and surface name with lengths only — never the typed text —
 * and `surface.control` a person taking a surface over from an agent or handing it back. The `input.*`
 * events are the secure input bridge (docs/input-requests.md): a request raised, delivered, refused,
 * expired or cancelled, named by the program or host that reads it and never by what was typed.
 * `link.opened` is a web address handed to this computer’s own browser, named by host only.
 */
export const AUDIT_EVENTS = [
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
  'terminal.input',
  'fleet.configured',
  'grants.changed',
  'secrets.used',
  'secrets.changed',
  'catalog.changed',
  'catalog.exported',
  'catalog.share.minted',
  'catalog.share.ended',
  'catalog.member.revoked',
  'catalog.member.key-removed',
  'catalog.member.catalog-removed',
  'catalog.share.cross-member',
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
] as const;
export const AuditEventSchema = z.enum(AUDIT_EVENTS);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * The events that must never be lost: who may reach this machine, and what they may do there.
 *
 * A SUCCESS of one of these is written to the KEPT store, which no refusal and no ordinary record can
 * rotate. Everything that is merely ACTIVITY — a terminal attached or typed into, a secret used, an
 * agent prompted, a code minted — is deliberately NOT here, however much it matters: a paired device
 * can repeat activity at will, and a store that took it would be a store a device could flood. Activity
 * is folded per actor, event and subject per window into the general store instead.
 *
 * Every event here can still be caused by a paired device — it can pair a second device, change a
 * grant, store a secret — so the daemon also caps how many kept records ALL callers who are not this
 * machine may write per day. See `docs/audit.md`.
 */
export const AUDIT_KEPT_EVENTS: readonly AuditEvent[] = [
  'device.paired',
  'device.revoked',
  'device.expired',
  'device.key-rotated',
  'passkey.registered',
  'grants.changed',
  'secrets.changed',
  'catalog.changed',
  'catalog.exported',
  'catalog.share.minted',
  'catalog.share.ended',
  'catalog.member.revoked',
  'catalog.member.key-removed',
  'catalog.member.catalog-removed',
  'catalog.share.cross-member',
  'security.changed',
  'warden.configured',
];

/**
 * Who did it.
 *
 * `host` is somebody at the machine — the admin token, the command line, a browser that arrived on
 * the host's own carrier with no device grant behind it. `device` is a paired device acting under its
 * own grant, named by id and, where the emitter knows it, by the name its owner gave it. `warden` is a
 * supervising session acting under the authority it was handed. `anonymous` is a caller who has not
 * proved who they are — the only one is somebody presenting a pairing code, and it appears only on a
 * refused `pairing.refused` record, because a successful redemption is recorded as the new device.
 */
export const AUDIT_ACTOR_KINDS = ['host', 'device', 'warden', 'anonymous'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

/** A name or an id: short, single-line, never markup. Long enough for every id this daemon mints. */
const AuditTextSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'audit text must be one line with no control characters');

export const AuditActorSchema = z.strictObject({
  kind: AuditActorKindSchema,
  /** The paired device's id, for `device`; a warden's session id is not a device and goes nowhere. */
  deviceId: AuditTextSchema.optional(),
  /** Untrusted, owner-chosen text: render as text content only. */
  deviceName: AuditTextSchema.optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/**
 * The fixed phrases a reader sees for the actors that are NOT a device.
 *
 * ONE LIST, OWNED HERE, because two facts must agree about it: every renderer says these words for
 * `host`, `warden` and `anonymous`, and the pairing service refuses a device NAME equal to any of
 * them. A device named "this computer" would otherwise read, in every log line it caused, as if the
 * machine's owner had acted. Renderers also mark a device's name as quoted, untrusted text with a
 * short id beside it, so this refusal is the second layer rather than the only one.
 */
export const AUDIT_RESERVED_ACTOR_PHRASES = [
  'this computer',
  'a supervising agent',
  'someone who is not paired',
  'a paired device',
] as const;

/** Whether a device name would read as one of the fixed actor phrases, ignoring case and spacing. */
export function isReservedActorPhrase(name: string): boolean {
  const folded = name.trim().replace(/\s+/gu, ' ').toLowerCase();
  return AUDIT_RESERVED_ACTOR_PHRASES.some(phrase => phrase === folded);
}

/**
 * The last six characters of a device id: enough to tell two devices with the same chosen name apart
 * at a glance, short enough to sit beside the name. A reader compares it with Settings › Devices.
 */
export function auditShortId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

/** What happened, in the two words a reader needs: it worked, or it was refused or failed. */
export const AUDIT_OUTCOMES = ['succeeded', 'refused', 'failed'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * Short scalar facts about a record — `carrier: "relay"`, `changes: "fleet.use=off"`.
 *
 * A BOUNDED MAP OF BOUNDED SCALARS rather than an open object, so there is nowhere to put a nested
 * document, a request body or an argv. Twelve keys of at most 160 characters each is room for every
 * fact an emitter has today and is too small to smuggle a command line through by accident.
 */
const AuditDetailKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u, 'audit detail keys are short camelCase');
export const AuditDetailSchema = z
  .record(AuditDetailKeySchema, z.union([AuditTextSchema, z.number().finite(), z.boolean()]))
  .refine(detail => Object.keys(detail).length <= 12, 'an audit record carries at most twelve details');
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

/** One record, exactly as it is written to `audit.jsonl` and exactly as a reader is told about it. */
export const AuditRecordSchema = z.strictObject({
  at: InstantSchema,
  event: AuditEventSchema,
  actor: AuditActorSchema,
  /** What it was done TO — a device id, a session id, a credential id, a secret's name. */
  subject: AuditTextSchema.optional(),
  outcome: AuditOutcomeSchema,
  detail: AuditDetailSchema.optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/**
 * How many records one read may return, and how many it returns when the caller does not say.
 *
 * BOUNDED because the log is two files of up to a mebibyte each, and the question people actually
 * have is "what happened recently", not "replay the year".
 */
export const AUDIT_MAX_LIMIT = 200 as const;
export const AUDIT_DEFAULT_LIMIT = 50 as const;

export const AuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).default(AUDIT_DEFAULT_LIMIT),
  /** How many of the newest kept records to skip, so a reader can page back through every one. */
  keptOffset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * The recent audit history, newest first, in TWO LISTS.
 *
 * `kept` is a page of the records that must never be lost (see {@link AUDIT_KEPT_EVENTS}) and
 * `records` is the recent activity — everything else, refusals included. They are separate so that
 * no amount of activity can push a pairing out of view: a reader shows `kept` first, and
 * `keptTotal` says how many there are so it can page back with `keptOffset` until it has seen all.
 *
 * `unreadable` IS NOT DECORATION. A line this daemon cannot parse is damage — a truncated write, a
 * hand edit, tampering — and dropping it silently would let a damaged history read as a clean one.
 * The count travels with the records so a reader is TOLD their history has a hole in it.
 */
export const AuditViewSchema = z.strictObject({
  records: z.array(AuditRecordSchema).max(AUDIT_MAX_LIMIT).readonly(),
  kept: z.array(AuditRecordSchema).max(AUDIT_MAX_LIMIT).readonly(),
  keptTotal: NonNegativeIntegerSchema,
  unreadable: NonNegativeIntegerSchema,
});
export type AuditView = z.infer<typeof AuditViewSchema>;
