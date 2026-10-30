import type { AgendaItem, AgendaSnapshot } from '@ferretry/protocol';
import { type AgendaRaisedObserver, ownerTurnItems } from '../agenda/index.ts';
import {
  agendaNotificationAttribution,
  deadlineNotificationPayload,
  legacyNotificationKey,
  type NotificationIdentity,
  notificationKey,
  pingNotificationPayload,
  type SessionNotificationPayload,
  stoppedNotificationPayload,
} from './policy.ts';
import {
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationLedgerEntry,
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
export class NotificationService implements AgendaRaisedObserver {
  constructor(private readonly options: NotificationServiceOptions) {}

  /** How many devices a push would reach now: every enrolled one, whatever it filters. */
  async enrolledDevices(): Promise<number> {
    return (await this.options.push.list()).length;
  }

  /**
   * How many devices accepted the push a notice's `--ping` made, as the ledger recorded it; zero when
   * nothing was pushed (no device, an unreadable ledger, or a notice that did not ask).
   */
  async agendaDelivered(sessionId: string, agendaId: string): Promise<number> {
    const entry = await this.recorded(notificationKey({ sessionId, agendaId, ping: true })).catch(() => undefined);
    return entry?.outcome?.error === undefined ? (entry?.outcome?.delivered ?? 0) : 0;
  }

  /**
   * A new item reached its board. Only a notice that asked for the phone to buzz makes a push; everything
   * else raised — an agenda item, a warden's card — waits for the stop or the deadline. Total.
   */
  async raised(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    if (item.notice !== true || item.ping !== true) return;
    await this.announce({ sessionId, agendaId: item.id, ping: true }, item, () =>
      pingNotificationPayload(sessionId, item, snapshot),
    );
  }

  /**
   * The ferret stopped on the owner: ONE push for the stop, "<ferret> is stopped · N need you", whatever
   * the number of items waiting. `stoppedAt` is the instant the turn boundary was recorded, which names the
   * stop; asking again for the same stop is no second push. Total.
   */
  async stopped(sessionId: string, stoppedAt: string, snapshot: AgendaSnapshot): Promise<void> {
    const [first, ...rest] = ownerTurnItems(snapshot.items);
    if (first === undefined) return;
    await this.announce({ sessionId, agendaId: first.id, stoppedAt }, first, session =>
      stoppedNotificationPayload(sessionId, session.name, [first, ...rest], snapshot),
    );
  }

  /** The item's `neededBy` came within the warning window: its one push, never a second. Total. */
  async deadline(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    await this.announce({ sessionId, agendaId: item.id, deadline: true }, item, () =>
      deadlineNotificationPayload(sessionId, item, snapshot, this.options.clock.now()),
    );
  }

  /**
   * What the ledger knows of one identity under EITHER spelling of its key. A push made before the agenda
   * rename is recorded as `attention:…`; looking only for `agenda:…` would announce it a second time.
   */
  private async recorded(key: string): Promise<NotificationLedgerEntry | undefined> {
    return (await this.options.ledger.find(key)) ?? (await this.options.ledger.find(legacyNotificationKey(key)));
  }

  private async announce(
    identity: NotificationIdentity,
    item: AgendaItem,
    compose: (session: NotificationSessionFacts) => SessionNotificationPayload,
  ): Promise<void> {
    const { sessionId } = identity;
    const key = notificationKey(identity);
    await this.options.serial
      .run(key, async () => {
        if ((await this.recorded(key)) !== undefined) return;
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
            origin: 'agenda',
            attribution: agendaNotificationAttribution(item),
            sessionId,
            agendaId: item.id,
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
