import { type AgendaSnapshot, agendaItemPushTag, PUSH_SEEN_MAX_TAGS, type PushPayload } from '@ferretry/protocol';
import {
  type AgendaBoardChange,
  type AgendaChangeObserver,
  type AgendaLedgerRepository,
  agendaSnapshot,
  emptyAgendaLedger,
} from '../agenda/index.ts';
import type { PushDispatch } from '../push/types.ts';
import {
  agendaAlertLane,
  alertsToClear,
  stopLineDone,
  clearNotificationKey,
  clearPushPayload,
  type DeliveredAlert,
  normalizedNotificationKey,
} from './policy.ts';
import {
  type NotificationClock,
  type NotificationDeliveryLedger,
  type NotificationLedgerEntry,
  NotificationRecordSchema,
  type NotificationSerialExecutor,
} from './types.ts';

export interface AgendaAlertClearerOptions {
  readonly ledger: Pick<NotificationDeliveryLedger, 'entries' | 'append'>;
  readonly boards: Pick<AgendaLedgerRepository, 'read'>;
  readonly push: { notify(dispatch: PushDispatch<PushPayload>): Promise<unknown> };
  /** The alert lanes, shared with `NotificationService`'s `lanes` (`agendaAlertLane`). */
  readonly serial: NotificationSerialExecutor;
  readonly clock: NotificationClock;
}

/**
 * What a `seen` did: no such item on that board, or the tags its clear named — empty when nothing of the item's was
 * still up. The caller's own page takes the same tags down on its device, which the clear skipped.
 */
export type AlertSeenOutcome = { readonly found: false } | { readonly found: true; readonly tags: readonly string[] };

/**
 * TAKES A HANDLED ITEM'S ALERTS DOWN ON EVERY DEVICE (docs/notifications.md § When an alert is cleared).
 *
 * The owner's ask: "if an agenda went to sleep, then you should dismiss all notifications sent out related to the
 * agenda! or when on 1 device is alr replied or resolved. then it should dismiss on other phones".
 *
 * After every committed board change it re-reads the board (never the change's own snapshot, so observers running out
 * of order cannot clear from a stale one) and sends a clear for each pushed alert whose item no longer waits on the
 * owner — answered, resolved, resting, snoozed or on the ferret's turn, by anyone. `seen` does the same for an item the
 * owner opened in the app, reaching every device but the one they opened it on.
 *
 * A clear names only tags (`clearPushPayload`). Each push is cleared once: the clear is recorded in the notification
 * ledger, with the pushes it covers, BEFORE it is sent, so a restart or a second change never clears it again.
 *
 * A clear is never a notification the owner asked for, so it is kept out of the notification diagnostics: one that
 * reached no device (the only device was the one that opened the item) must not turn `fy doctor` red. Total: a clear
 * that cannot be made leaves the alert up, which is the state before this existed.
 */
export class AgendaAlertClearer implements AgendaChangeObserver {
  /**
   * Opens made while one of the item's pushes was still on its way, by that push's key: honoured when it lands
   * (`recheck`), because at the open there was nothing on any screen yet to take down — on ANY device, the opener's
   * included: its page closed only what was showing when it asked. In memory: a restart between the
   * open and the push landing leaves that one line up.
   */
  private readonly pendingOpens = new Map<string, PendingOpen>();

  constructor(private readonly options: AgendaAlertClearerOptions) {}

  async changed(sessionId: string, _change: AgendaBoardChange): Promise<void> {
    await this.recheck(sessionId);
  }

  /**
   * Looks at one session's alerts again: after a board change, and after one of its pushes reached a device — an item
   * handled or opened while its push was still on its way had nothing to clear then. Total.
   */
  async recheck(sessionId: string): Promise<void> {
    await this.run(sessionId, async (snapshot, entries) => {
      await this.send(sessionId, snapshot, entries, {});
      for (const [key, open] of [...this.pendingOpens]) {
        if (open.sessionId !== sessionId) continue;
        // Read again for what the sends so far covered. Newer than the board, but each send is held to one push
        // that was already on its way at the open, before the board was read.
        const now = await this.options.ledger.entries();
        const landed = now.find(entry => normalizedNotificationKey(entry.requested.key) === key);
        if (landed !== undefined && landed.outcome === undefined) continue;
        this.pendingOpens.delete(key);
        // EVERY device, the opener's too: its page closed what was showing when it asked, and this line came after.
        await this.send(sessionId, snapshot, now, { opened: open.agendaId, only: key });
      }
    }).catch(() => undefined);
  }

  /**
   * At start: every session with an alert this release pushed and no clear has covered is looked at once, for a board
   * that changed while this
   * daemon was down or before an observer ran. Total.
   */
  async sweep(): Promise<void> {
    const entries = await this.options.ledger.entries().catch(() => []);
    const sessions = new Set(
      entries.flatMap(entry => (entry.requested.origin === 'direct' ? [] : [entry.requested.sessionId])),
    );
    // Only a push this release made wakes a look (review round 8): one recorded before tags were is left for its own
    // ferret's next change, so the first start after upgrade sends no burst of clears for lines long dismissed.
    const tagged = entries.filter(
      ({ requested }) => requested.origin === 'agenda-clear' || ('tag' in requested && requested.tag !== undefined),
    );
    for (const sessionId of sessions) if (uncoveredAlerts(sessionId, tagged).length > 0) await this.recheck(sessionId);
  }

  /** The owner opened `agendaId` on the device `exceptDevice` names: its alerts come down everywhere else. */
  async seen(sessionId: string, agendaId: string, exceptDevice?: string): Promise<AlertSeenOutcome> {
    // Read BEFORE waiting for the lane (review rounds 6–8): a push of the item's still being sent when the owner
    // opened it reached no page that could close it, so once it lands it comes down on every device. One that had
    // already landed is the ordinary clear's, which skips the opener: its page closes the item's own lines itself,
    // so the phone just tapped never says "Handled on another device".
    const admitted = Date.parse(this.options.clock.now());
    const before = await this.options.ledger.entries();
    return await this.run(sessionId, async (snapshot, entries) => {
      if (![...snapshot.items, ...snapshot.resolved].some(item => item.id === agendaId)) return { found: false };
      // A stop on its way counts too when this open is what lets its line come down (the last item it could count).
      const stopsToo = stopLineDone(snapshot, agendaId);
      let current = entries;
      for (const key of onItsWayAtOpen(sessionId, agendaId, stopsToo, before, admitted)) {
        const landed = entries.find(entry => normalizedNotificationKey(entry.requested.key) === key)?.outcome;
        if (landed === undefined) {
          this.remember(key, { sessionId, agendaId });
          continue;
        }
        // Landed since the open: EVERY device, the opener's too, as a pending open's late clear does.
        await this.send(sessionId, snapshot, current, { opened: agendaId, only: key });
        current = await this.options.ledger.entries();
      }
      return {
        found: true,
        tags: await this.send(sessionId, snapshot, current, {
          opened: agendaId,
          ...(exceptDevice === undefined ? {} : { exceptDevice }),
        }),
      };
    });
  }

  /** The oldest a push recorded before tags were may be and still be cleared (`LEGACY_CLEARABLE_FOR_MS`). */
  private legacySince(): number {
    return Date.parse(this.options.clock.now()) - LEGACY_CLEARABLE_FOR_MS;
  }

  private remember(key: string, open: PendingOpen): void {
    this.pendingOpens.delete(key);
    this.pendingOpens.set(key, open);
    // Bounded: a push that never lands must not grow this for the daemon's life. The oldest goes first.
    for (const oldest of [...this.pendingOpens.keys()].slice(
      0,
      Math.max(0, this.pendingOpens.size - MAX_PENDING_OPENS),
    ))
      this.pendingOpens.delete(oldest);
  }

  /**
   * Runs one look at a session in its alert lane (`agendaAlertLane`), which its pushes share, so no push is recorded or
   * sent while a clear is decided and sent from the board it read. THE LEDGER IS READ BEFORE THE BOARD as well: every push it
   * names was recorded before the board was read, so the board is never older than a push it judges. A push recorded
   * after (the item woke, the next was raised) is not in this look at all; its own landing looks again.
   */
  private async run<T>(
    sessionId: string,
    work: (snapshot: AgendaSnapshot, entries: readonly NotificationLedgerEntry[]) => Promise<T>,
  ): Promise<T> {
    return await this.options.serial.run(agendaAlertLane(sessionId), async () => {
      const entries = await this.options.ledger.entries();
      const now = this.options.clock.now();
      const ledger = (await this.options.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, now);
      return await work(agendaSnapshot(ledger), entries);
    });
  }

  /** Records and sends every clear the board calls for now, from the ledger as `entries` read it; the tags they named. */
  private async send(
    sessionId: string,
    snapshot: AgendaSnapshot,
    entries: readonly NotificationLedgerEntry[],
    how: SendOptions,
  ): Promise<readonly string[]> {
    let sequence = entries.filter(entry => entry.requested.origin === 'agenda-clear').length;
    const uncovered = uncoveredAlerts(sessionId, entries, this.legacySince()).filter(
      alert => how.only === undefined || pushKeyOf(alert) === how.only,
    );
    const clears = alertsToClear(sessionId, uncovered, snapshot, how.opened);
    // The tags the caller is answered, which its page closes itself. Past what one answer may carry, a clear skips
    // nobody: the caller's device takes those lines down too, rather than keeping them.
    const answered: string[] = [];
    for (const clear of clears) {
      const at = this.options.clock.now();
      sequence += 1;
      const key = clearNotificationKey(sessionId, at, sequence);
      const fits = answered.length + clear.tags.length <= PUSH_SEEN_MAX_TAGS;
      const skip = fits && how.exceptDevice !== undefined;
      if (fits) answered.push(...clear.tags);
      await this.options.ledger.append(
        NotificationRecordSchema.parse({
          v: 1,
          phase: 'requested',
          key,
          at,
          origin: 'agenda-clear',
          sessionId,
          ...(how.opened === undefined ? {} : { opened: how.opened }),
          covers: clear.covers,
          tags: clear.tags,
          enrolled: 0,
        }),
      );
      await this.options.push
        .notify({
          payload: clearPushPayload(sessionId, key, clear.tags),
          ...(skip ? { exceptDevice: how.exceptDevice } : {}),
        })
        .catch(() => undefined);
    }
    return answered;
  }
}

/**
 * How far back a push recorded before tags were is still cleared (review round 7). No daemon before this one wrote a
 * clear, so on the first start every push it ever made counts as uncovered: without a bound, the sweep would send
 * hundreds of clears for lines dismissed days ago, and a browser that revokes a site whose pushes show nothing would
 * drop the subscription. A push made by this release has no such bound: its item may be answered days later.
 */
const LEGACY_CLEARABLE_FOR_MS = 2 * 24 * 60 * 60_000;

/** The most opens remembered while their pushes are on their way. */
const MAX_PENDING_OPENS = 256;

interface PendingOpen {
  readonly sessionId: string;
  readonly agendaId: string;
}

interface SendOptions {
  /** The item the owner opened, whose alerts come down though it still waits. */
  readonly opened?: string | undefined;
  /** The device that opened it, which the clear skips. */
  readonly exceptDevice?: string | undefined;
  /** Only this push's alerts: an open honoured once that push landed. */
  readonly only?: string | undefined;
}

/** The suffix that names a legacy push's second, item-tag alert (`uncoveredAlerts`). */
const ITEM_VARIANT = '#item';

/** The ledger key of the push an alert is about, whichever of its tags the alert names. */
const pushKeyOf = (alert: DeliveredAlert): string =>
  alert.key.endsWith(ITEM_VARIANT) ? alert.key.slice(0, -ITEM_VARIANT.length) : alert.key;

/**
 * The keys of one item's pushes that were on their way when the owner opened it, as `entries` read then (at
 * `admitted`): recorded and not landed yet — for at most `IN_FLIGHT_FOR_MS`, past which a push that never got an
 * outcome is not coming. With `stopsToo`, the session's stops as well, whichever item a stop's record names (a stop is
 * about the group).
 */
function onItsWayAtOpen(
  sessionId: string,
  agendaId: string,
  stopsToo: boolean,
  entries: readonly NotificationLedgerEntry[],
  admitted: number,
): string[] {
  return entries.flatMap(({ requested, outcome }) =>
    (requested.origin === 'agenda' || requested.origin === 'attention') &&
    requested.sessionId === sessionId &&
    (requested.agendaId === agendaId || (stopsToo && requested.stoppedAt !== undefined)) &&
    outcome === undefined &&
    admitted - Date.parse(requested.at) <= IN_FLIGHT_FOR_MS
      ? [normalizedNotificationKey(requested.key)]
      : [],
  );
}

/** How long a recorded push with no outcome counts as on its way: longer than any push transport takes. */
const IN_FLIGHT_FOR_MS = 10 * 60_000;

/**
 * The pushes for one session a device accepted and no clear has covered yet. A push that reached nothing, or
 * errored, has no line on any screen to take down.
 *
 * A push recorded before tags were is named by every tag it may have gone out under: an approve-on-phone push by its
 * approval's (`approval`, resolved from the board), a stop's by the session's and the code cards waiting then
 * (`legacyStop`: a high stop showed one), and any other by the session's AND — as a second alert, keyed
 * `<key>#item` and covered on its own — the item's, which a high push used. One made before `legacySince` is left up.
 */
export function uncoveredAlerts(
  sessionId: string,
  entries: readonly NotificationLedgerEntry[],
  legacySince = Number.NEGATIVE_INFINITY,
): readonly DeliveredAlert[] {
  const covered = new Set(
    entries.flatMap(entry => (entry.requested.origin === 'agenda-clear' ? entry.requested.covers : [])),
  );
  return entries.flatMap((entry): DeliveredAlert[] => {
    const { requested, outcome } = entry;
    if (requested.origin !== 'agenda' && requested.origin !== 'attention') return [];
    if (requested.sessionId !== sessionId) return [];
    if (outcome === undefined || outcome.error !== undefined || outcome.delivered === 0) return [];
    if (requested.tag === undefined && Date.parse(requested.at) < legacySince) return [];
    const key = normalizedNotificationKey(requested.key);
    const base = { agendaId: requested.agendaId, stop: requested.stoppedAt !== undefined };
    const alerts: DeliveredAlert[] =
      requested.tag !== undefined
        ? [{ key, ...base, tag: requested.tag }]
        : requested.phoneApproval !== undefined
          ? [{ key, ...base, approval: true }]
          : requested.stoppedAt !== undefined
            ? [{ key, ...base, legacyStop: true }]
            : [
                { key, ...base },
                {
                  key: `${key}${ITEM_VARIANT}`,
                  ...base,
                  stop: false,
                  tag: agendaItemPushTag(sessionId, requested.agendaId),
                },
              ];
    return alerts.filter(alert => !covered.has(alert.key));
  });
}
