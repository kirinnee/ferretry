import { type AgendaItem, type AgendaSnapshot, type PushSubject, pushUrgencyFor } from '@ferretry/protocol';
import { type AgendaRaisedObserver, ownerTurnItems } from '../agenda/index.ts';
import {
  agendaNotificationAttribution,
  deadlineNotificationPayload,
  legacyNotificationKey,
  type NotificationIdentity,
  notificationKey,
  pingNotificationPayload,
  type SessionNotificationPayload,
  stopShows,
  stoppedNotificationPayload,
  wokeNotificationPayload,
} from './policy.ts';
import {
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationDiagnostics,
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
  /**
   * Told what became of every push: made, or failed and why. Announcing stays total, so without it a
   * push that cannot be made leaves no trace outside the ledger — and none at all when the ledger is
   * what fails. The daemon logs each failure and reports the newest in `fy doctor`.
   */
  readonly diagnostics?: NotificationDiagnostics;
  /**
   * What an item is about, for how urgently its push must reach a phone (`pushUrgencyFor`): an input card asking for a
   * one-time code is `one-time-code`. Absent, or `other`, is a normal push.
   */
  readonly subjectOf?: (sessionId: string, item: AgendaItem) => PushSubject;
}

/**
 * The phone's three reasons to buzz, durable duplicate suppression, and the sole call into push fan-out.
 *
 * A push is made for a notice that asked for one (`raised`), for the stop of a ferret that waits on the
 * owner (`stopped`) and for an item whose deadline came within the warning window (`deadline`) — and for
 * nothing else (docs/notifications.md). Each is recorded under its own identity before it is sent, so a
 * repeat of the same stop, item or notice is no second push, across restarts too.
 */
/**
 * The most HIGH-priority pushes in any rolling hour: per ferret, and across the whole daemon. Past either a push still
 * goes, once per card as always, at normal priority. The per-ferret bucket is the tighter one, so a ferret raising card
 * after card spends its own three and never the slots another ferret's real code needs.
 */
export const HIGH_PUSHES_PER_SESSION_PER_HOUR = 3;
export const HIGH_PUSHES_PER_HOUR = 12;
const HOUR_MS = 3_600_000;

export class NotificationService implements AgendaRaisedObserver {
  /** When each recent high push was sent, oldest first, daemon-wide and per session: the rolling windows. */
  private readonly highSent: number[] = [];
  private readonly highSentBySession = new Map<string, number[]>();

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
    await this.announce(
      { sessionId, agendaId: first.id, stoppedAt },
      first,
      session => stoppedNotificationPayload(sessionId, session.name, [first, ...rest], snapshot),
      stopShows([first, ...rest]),
    );
  }

  /** The item's `neededBy` came within the warning window: its one push, never a second. Total. */
  async deadline(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    await this.announce({ sessionId, agendaId: item.id, deadline: true }, item, () =>
      deadlineNotificationPayload(sessionId, item, snapshot, this.options.clock.now()),
    );
  }

  /** A snoozed item woke and it blocks or has a deadline: its one push for this wake. Total. */
  async woke(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    await this.announce({ sessionId, agendaId: item.id, woke: item.waitingSince }, item, () =>
      wokeNotificationPayload(sessionId, item, snapshot),
    );
  }

  /**
   * What the ledger knows of one identity under EITHER spelling of its key. A push made before the agenda
   * rename is recorded as `attention:…`; looking only for `agenda:…` would announce it a second time.
   */
  private async recorded(key: string): Promise<NotificationLedgerEntry | undefined> {
    return (await this.options.ledger.find(key)) ?? (await this.options.ledger.find(legacyNotificationKey(key)));
  }

  /**
   * The item a push SHOWS, when its push must be high priority (a one-time code card), or nothing. Only the item the
   * push shows decides, so a code card waiting behind another item never makes that item's push loud.
   */
  private urgentOf(sessionId: string, shown: AgendaItem): { readonly item: AgendaItem; readonly at: number } | undefined {
    const subjectOf = this.options.subjectOf;
    if (subjectOf === undefined || pushUrgencyFor(subjectOf(sessionId, shown)) !== 'high') return undefined;
    // Both caps: counted and taken in one synchronous step, so two pushes cannot both take the last slot.
    const now = Date.parse(this.options.clock.now());
    const recent = (sent: readonly number[]): number[] => sent.filter(at => at > now - HOUR_MS);
    const daemon = recent(this.highSent);
    const session = recent(this.highSentBySession.get(sessionId) ?? []);
    this.highSent.splice(0, this.highSent.length, ...daemon);
    if (session.length === 0) this.highSentBySession.delete(sessionId);
    else this.highSentBySession.set(sessionId, session);
    if (session.length >= HIGH_PUSHES_PER_SESSION_PER_HOUR || daemon.length >= HIGH_PUSHES_PER_HOUR) return undefined;
    this.highSent.push(now);
    this.highSentBySession.set(sessionId, [...session, now]);
    return { item: shown, at: now };
  }

  /** Gives back a high slot whose push reached no device: a slot is spent only on a push that went out. */
  private refund(sessionId: string, at: number): void {
    const drop = (sent: number[]): void => {
      const index = sent.indexOf(at);
      if (index >= 0) sent.splice(index, 1);
    };
    drop(this.highSent);
    const session = this.highSentBySession.get(sessionId);
    if (session === undefined) return;
    drop(session);
    if (session.length === 0) this.highSentBySession.delete(sessionId);
  }

  private async announce(
    identity: NotificationIdentity,
    item: AgendaItem,
    compose: (session: NotificationSessionFacts) => SessionNotificationPayload,
    shown: AgendaItem = item,
  ): Promise<void> {
    const { sessionId } = identity;
    const key = notificationKey(identity);
    await this.options.serial
      .run(key, async () => {
        if ((await this.recorded(key)) !== undefined) return;
        const session = await this.options.sessions.describe(sessionId);
        if (session === undefined) return;
        const composed = compose(session);
        // A high push gets its own tag (one per card), so the platform sounds it again rather than folding it in silently.
        const urgent = this.urgentOf(sessionId, shown);
        const payload: SessionNotificationPayload =
          urgent === undefined ? composed : { ...composed, urgency: 'high', tag: `${composed.tag}:${urgent.item.id}` };
        // The high slot is kept only when a device accepted the push; every other ending gives it back.
        let reached = false;
        try {
          reached = await this.send(identity, item, key, session, payload, urgent !== undefined);
        } finally {
          if (urgent !== undefined && !reached) this.refund(sessionId, urgent.at);
        }
      })
      .catch((error: unknown) => this.tell(diagnostics => diagnostics.failed(key, errorText(error))));
  }

  /** Records, sends and records the outcome of one push: whether a device accepted it. */
  private async send(
    identity: NotificationIdentity,
    item: AgendaItem,
    key: string,
    session: NotificationSessionFacts,
    payload: SessionNotificationPayload,
    high: boolean,
  ): Promise<boolean> {
    const { sessionId } = identity;
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
        ...(identity.woke === undefined ? {} : { woke: identity.woke }),
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
      ({ delivered, failed } = await this.options.push.notify({
        payload,
        ...(high ? { urgency: 'high' as const } : {}),
      }));
    } catch (error) {
      this.tell(diagnostics => diagnostics.failed(key, errorText(error)));
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
      return false;
    }
    this.tell(diagnostics => diagnostics.made(key, { delivered, failed }));
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
    return delivered > 0;
  }

  private tell(say: (diagnostics: NotificationDiagnostics) => void): void {
    if (this.options.diagnostics === undefined) return;
    try {
      say(this.options.diagnostics);
    } catch {
      // Saying a push failed must never be what fails.
    }
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? 'unknown notification delivery error' : message;
}
