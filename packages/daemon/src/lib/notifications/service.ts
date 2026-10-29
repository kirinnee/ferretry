import type { AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import type { AttentionRaisedObserver } from '../attention/index.ts';
import {
  attentionNotificationAttribution,
  attentionNotificationPayload,
  moreInfoNotificationPayload,
  notificationKey,
} from './policy.ts';
import {
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationPushDispatcher,
  NotificationRecordSchema,
  type NotificationSerialExecutor,
  type NotificationSessionDirectory,
} from './types.ts';

export interface NotificationServiceOptions {
  readonly ledger: NotificationDeliveryLedger;
  readonly sessions: NotificationSessionDirectory;
  readonly push: NotificationPushDispatcher;
  readonly serial: NotificationSerialExecutor;
  readonly clock: NotificationClock;
}

/** Notification policy, durable duplicate suppression, and the sole call into push fan-out. */
export class NotificationService implements AttentionRaisedObserver {
  constructor(private readonly options: NotificationServiceOptions) {}

  /** How many devices an Attention push would reach now: every enrolled one, whatever it filters. */
  async enrolledDevices(): Promise<number> {
    return (await this.options.push.list()).length;
  }

  /**
   * How many devices accepted the push an item's raise made, as the ledger recorded it; zero when nothing
   * was pushed (no device, an unreadable ledger, or an item that never announced).
   */
  async attentionDelivered(sessionId: string, attentionId: string): Promise<number> {
    const entry = await this.options.ledger.find(notificationKey({ sessionId, attentionId })).catch(() => undefined);
    return entry?.outcome?.error === undefined ? (entry?.outcome?.delivered ?? 0) : 0;
  }

  /** Attention observer entry point; it is total even when every collaborator rejects. */
  async raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    await this.attentionRaised(sessionId, item, snapshot);
  }

  /** The one push an edit makes: the ferret added what the owner asked for. Total, once per request. */
  async moreInfoAdded(
    sessionId: string,
    item: AttentionItem,
    snapshot: AttentionSnapshot,
    discussion = false,
  ): Promise<void> {
    if (item.infoRequests === undefined) return;
    await this.attentionRaised(sessionId, item, snapshot, item.infoRequests, discussion);
  }

  /** Announces one committed item at most once under its durable board identity. */
  async attentionRaised(
    sessionId: string,
    item: AttentionItem,
    snapshot: AttentionSnapshot,
    infoRequest?: number,
    discussion = false,
  ): Promise<void> {
    const key = notificationKey({
      sessionId,
      attentionId: item.id,
      ...(infoRequest === undefined ? {} : { infoRequest }),
    });
    await this.options.serial
      .run(key, async () => {
        if ((await this.options.ledger.find(key)) !== undefined) return;
        const session = await this.options.sessions.describe(sessionId);
        if (session === undefined) return;
        const payload =
          infoRequest === undefined
            ? attentionNotificationPayload(sessionId, item, snapshot)
            : moreInfoNotificationPayload(sessionId, item, snapshot, infoRequest, discussion);
        const enrolled = (await this.options.push.list()).length;
        await this.options.ledger.append(
          NotificationRecordSchema.parse({
            v: 1,
            phase: 'requested',
            key,
            at: this.options.clock.now(),
            origin: 'attention',
            attribution: attentionNotificationAttribution(item),
            sessionId,
            attentionId: item.id,
            ...(infoRequest === undefined ? {} : { infoRequest }),
            sent: {
              kind: payload.kind,
              interactive: session.interactive,
              title: payload.title,
              body: payload.body,
            },
            enrolled,
          }),
        );
        let delivered: number;
        let failed: number;
        try {
          ({ delivered, failed } = await this.options.push.notify({ payload }));
        } catch (error) {
          await this.options.ledger
            .append(
              NotificationRecordSchema.parse({
                v: 1,
                phase: 'outcome',
                key,
                at: this.options.clock.now(),
                delivered: 0,
                failed: 0,
                error: errorText(error),
              }),
            )
            .catch(() => undefined);
          return;
        }
        await this.options.ledger
          .append(
            NotificationRecordSchema.parse({
              v: 1,
              phase: 'outcome',
              key,
              at: this.options.clock.now(),
              delivered,
              failed,
            }),
          )
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? 'unknown notification delivery error' : message;
}
