import {
  AttentionIdSchema,
  DirectNotificationRequestSchema,
  type DirectNotificationResponse,
  InstantSchema,
  NonNegativeIntegerSchema,
  type PushDeliveryResult,
  PushNotificationKindSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { AttentionFailure } from '../attention/index.ts';
import type { SerialExecutor } from '../ports.ts';
import type { PushDispatch } from '../push/types.ts';

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

export const AttentionNotificationRequestedRecordSchema = z
  .strictObject({
    v: z.literal(1),
    phase: z.literal('requested'),
    key: z.string().startsWith('attention:'),
    at: InstantSchema,
    origin: z.literal('attention'),
    attribution: z.string().min(1),
    sessionId: z.string().min(1),
    attentionId: AttentionIdSchema,
    sent: SentNotificationSchema,
    enrolled: NonNegativeIntegerSchema,
  })
  .refine(record => record.key === `attention:${record.sessionId}:${record.attentionId}`, {
    message: 'the attention notification key does not name its session and item',
    path: ['key'],
  });

export const NotificationRequestedRecordSchema = z.union([
  DirectNotificationRequestedRecordSchema,
  AttentionNotificationRequestedRecordSchema,
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
  AttentionNotificationRequestedRecordSchema,
  NotificationOutcomeRecordSchema,
]);

export type DirectNotificationRequestedRecord = z.infer<typeof DirectNotificationRequestedRecordSchema>;
export type AttentionNotificationRequestedRecord = z.infer<typeof AttentionNotificationRequestedRecordSchema>;
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
  describe(sessionId: string): Promise<{ readonly name: string; readonly interactive: boolean } | undefined>;
}

/** The one delivery owner notifications may call. */
export interface NotificationPushDispatcher {
  list(): Promise<readonly unknown[]>;
  notify(dispatch: PushDispatch): Promise<PushDeliveryResult>;
}

export interface NotificationClock {
  now(): string;
}

export type NotificationSerialExecutor = Pick<SerialExecutor, 'run'>;

export type NotificationResult<T = DirectNotificationResponse> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AttentionFailure };
