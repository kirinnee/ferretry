import type { AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import { type AttentionRaisedObserver, ownerTurnItems } from '../attention/index.ts';
import {
  attentionNotificationAttribution,
  deadlineNotificationPayload,
  type NotificationIdentity,
  notificationKey,
  pingNotificationPayload,
  type SessionNotificationPayload,
  stoppedNotificationPayload,
} from './policy.ts';
import {
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationPushDispatcher,
  NotificationRecordSchema,
  type NotificationSerialExecutor,
  type NotificationSessionDirectory,
  type NotificationSessionFacts,
} from './types.ts';

export interface NotificationServiceOptions {
  readonly ledger: NotificationDeliveryLedger;
  readonly sessions: NotificationSessionDirectory;
  readonly push: NotificationPushDispatcher;
  readonly serial: NotificationSerialExecutor;
  readonly clock: NotificationClock;
}

/**
 * The phone's three reasons to buzz, durable duplicate suppression, and the sole call into push fan-out.
 *
 * A push is made for a notice that asked for one (`raised`), for the stop of a ferret that waits on the
 * owner (`stopped`) and for an item whose deadline came within the warning window (`deadline`) — and for
 * nothing else (docs/notifications.md). Each is recorded under its own identity before it is sent, so a
 * repeat of the same stop, item or notice is no second push, across restarts too.
 */
export class NotificationService implements AttentionRaisedObserver {
  constructor(private readonly options: NotificationServiceOptions) {}

  /** How many devices a push would reach now: every enrolled one, whatever it filters. */
  async enrolledDevices(): Promise<number> {
    return (await this.options.push.list()).length;
  }

  /**
   * How many devices accepted the push a notice's `--ping` made, as the ledger recorded it; zero when
   * nothing was pushed (no device, an unreadable ledger, or a notice that did not ask).
   */
  async attentionDelivered(sessionId: string, attentionId: string): Promise<number> {
    const entry = await this.options.ledger
      .find(notificationKey({ sessionId, attentionId, ping: true }))
      .catch(() => undefined);
    return entry?.outcome?.error === undefined ? (entry?.outcome?.delivered ?? 0) : 0;
  }

  /**
   * A new item reached its board. Only a notice that asked for the phone to buzz makes a push; everything
   * else raised — an agenda item, a warden's card — waits for the stop or the deadline. Total.
   */
  async raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    if (item.notice !== true || item.ping !== true) return;
    await this.announce({ sessionId, attentionId: item.id, ping: true }, item, () =>
      pingNotificationPayload(sessionId, item, snapshot),
    );
  }

  /**
   * The ferret stopped on the owner: ONE push for the stop, "<ferret> is stopped · N need you", whatever
   * the number of items waiting. `stoppedAt` is the instant the turn boundary was recorded, which names the
   * stop; asking again for the same stop is no second push. Total.
   */
  async stopped(sessionId: string, stoppedAt: string, snapshot: AttentionSnapshot): Promise<void> {
    const [first, ...rest] = ownerTurnItems(snapshot.items);
    if (first === undefined) return;
    await this.announce({ sessionId, attentionId: first.id, stoppedAt }, first, session =>
      stoppedNotificationPayload(sessionId, session.name, [first, ...rest], snapshot),
    );
  }

  /** The item's `neededBy` came within the warning window: its one push, never a second. Total. */
  async deadline(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    await this.announce({ sessionId, attentionId: item.id, deadline: true }, item, () =>
      deadlineNotificationPayload(sessionId, item, snapshot, this.options.clock.now()),
    );
  }

  private async announce(
    identity: NotificationIdentity,
    item: AttentionItem,
    compose: (session: NotificationSessionFacts) => SessionNotificationPayload,
  ): Promise<void> {
    const { sessionId } = identity;
    const key = notificationKey(identity);
    await this.options.serial
      .run(key, async () => {
        if ((await this.options.ledger.find(key)) !== undefined) return;
        const session = await this.options.sessions.describe(sessionId);
        if (session === undefined) return;
        const payload = compose(session);
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
            ...(identity.ping === true ? { ping: true } : {}),
            ...(identity.deadline === true ? { deadline: true } : {}),
            ...(identity.stoppedAt === undefined ? {} : { stoppedAt: identity.stoppedAt }),
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
