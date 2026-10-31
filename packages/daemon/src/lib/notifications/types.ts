import {
  AgendaIdSchema,
  DirectNotificationRequestSchema,
  InstantSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  type PushDeliveryResult,
  PushNotificationKindSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { SerialExecutor } from '../ports.ts';
import type { PushDispatch } from '../push/types.ts';
import { normalizedNotificationKey, notificationKey } from './policy.ts';

/**
 * The ledger excludes push endpoints, key material, push enrolment ids, and device names. A paired
 * device id is deliberately retained inside server-derived attribution so the audit can say who
 * requested a notification without exposing a browser address.
 */
const AcceptedDirectRequestSchema = z.strictObject({
  body: DirectNotificationRequestSchema.shape.body,
  title: DirectNotificationRequestSchema.shape.title.unwrap().nullable(),
  kind: DirectNotificationRequestSchema.shape.kind.unwrap().nullable(),
});

const SentNotificationSchema = z.strictObject({
  kind: PushNotificationKindSchema,
  interactive: z.boolean(),
  title: z.string().min(1),
  body: z.string(),
});

export const DirectNotificationRequestedRecordSchema = z.strictObject({
  v: z.literal(1),
  phase: z.literal('requested'),
  key: z.string().startsWith('direct:').min(8),
  at: InstantSchema,
  origin: z.literal('direct'),
  attribution: z.string().min(1),
  sessionId: z.string().min(1),
  request: AcceptedDirectRequestSchema,
  sent: SentNotificationSchema,
  enrolled: NonNegativeIntegerSchema,
});

/**
 * A daemon older than the agenda rename (v4.116.0) wrote an agenda record's item as `attentionId`. The ledger
 * is decision state that is never rewritten, and one line it cannot read fails EVERY lookup closed — so the old
 * spelling is read as `agendaId` for as long as such a line may exist. Writes always use `agendaId`.
 */
function withAgendaId(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  if (!('attentionId' in value) || 'agendaId' in value) return value;
  const { attentionId, ...rest } = value;
  return { ...rest, agendaId: attentionId };
}

const AgendaNotificationRequestedRecordObjectSchema = z
  .strictObject({
    v: z.literal(1),
    phase: z.literal('requested'),
    /** `agenda:` from now on; a ledger written before the rename holds `attention:`, and both are read. */
    key: z.string().regex(/^(agenda|attention):/u),
    at: InstantSchema,
    origin: z.enum(['agenda', 'attention']),
    attribution: z.string().min(1),
    sessionId: z.string().min(1),
    agendaId: AgendaIdSchema,
    /** Legacy: the push that announced the information a ferret added (this daemon no longer makes it). */
    infoRequest: PositiveIntegerSchema.optional(),
    /** Legacy: the push that announced an item moved out of discussion (this daemon no longer makes it). */
    surfaced: z.literal(true).optional(),
    /** The push for a ferret STOPPED on the owner: the idle period it was made for. At most one per period. */
    stoppedAt: z.string().min(1).optional(),
    /** The push for an item whose `neededBy` came near. At most one per item. */
    deadline: z.literal(true).optional(),
    /** The push for a notice the ferret asked to buzz for (`fy notify --ping`). At most one per notice. */
    ping: z.literal(true).optional(),
    /** The push for a snoozed item that woke: the instant it woke. At most one per wake. */
    woke: z.string().min(1).optional(),
    sent: SentNotificationSchema,
    enrolled: NonNegativeIntegerSchema,
  })
  .refine(record => normalizedNotificationKey(record.key) === notificationKey(record), {
    message: 'the agenda notification key does not name its session and item',
    path: ['key'],
  });

export const AgendaNotificationRequestedRecordSchema = z.preprocess(
  withAgendaId,
  AgendaNotificationRequestedRecordObjectSchema,
);

export const NotificationRequestedRecordSchema = z.union([
  DirectNotificationRequestedRecordSchema,
  AgendaNotificationRequestedRecordSchema,
]);

export const NotificationOutcomeRecordSchema = z.strictObject({
  v: z.literal(1),
  phase: z.literal('outcome'),
  key: z.string().min(1),
  at: InstantSchema,
  delivered: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
  error: z.string().min(1).optional(),
});

export const NotificationRecordSchema = z.union([
  DirectNotificationRequestedRecordSchema,
  AgendaNotificationRequestedRecordSchema,
  NotificationOutcomeRecordSchema,
]);

export type DirectNotificationRequestedRecord = z.infer<typeof DirectNotificationRequestedRecordSchema>;
export type AgendaNotificationRequestedRecord = z.infer<typeof AgendaNotificationRequestedRecordSchema>;
export type NotificationRequestedRecord = z.infer<typeof NotificationRequestedRecordSchema>;
export type NotificationOutcomeRecord = z.infer<typeof NotificationOutcomeRecordSchema>;
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

export interface NotificationLedgerEntry {
  readonly requested: NotificationRequestedRecord;
  readonly outcome?: NotificationOutcomeRecord;
}

/** Durable decision state for one daemon's logical notification identities. */
export interface NotificationDeliveryLedger {
  /** Everything durably known about one logical notification. */
  find(key: string): Promise<NotificationLedgerEntry | undefined>;
  /** Appends one phase line durably. A rejection means the ledger cannot testify. */
  append(record: NotificationRecord): Promise<void>;
}

/** The authoritative session facts a notification is composed from. */
export interface NotificationSessionDirectory {
  describe(sessionId: string): Promise<NotificationSessionFacts | undefined>;
}

/** What a notification says about the session it comes from. */
export interface NotificationSessionFacts {
  /** The ferret's spoken name. */
  readonly name: string;
  /** The conversation's name (the session's task title), which titles an Agenda push. */
  readonly title?: string;
  readonly interactive: boolean;
}

/** The one delivery owner notifications may call. */
export interface NotificationPushDispatcher {
  list(): Promise<readonly unknown[]>;
  notify(dispatch: PushDispatch): Promise<PushDeliveryResult>;
}

export interface NotificationClock {
  now(): string;
}

/** Where the notification service says what it could not do. */
export interface NotificationDiagnostics {
  warn(message: string): void;
}

export type NotificationSerialExecutor = Pick<SerialExecutor, 'run'>;
