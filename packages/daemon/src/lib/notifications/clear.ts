import { type AgendaSnapshot, agendaItemPushTag, type PushPayload } from '@ferretry/protocol';
import {
  type AgendaBoardChange,
  type AgendaChangeObserver,
  type AgendaLedgerRepository,
  agendaSnapshot,
  emptyAgendaLedger,
} from '../agenda/index.ts';
import type { PushDispatch } from '../push/types.ts';
import {
  alertsToClear,
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
   * (`recheck`), because at the open there was nothing on any screen yet to take down. In memory: a restart between the
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
    await this.run(sessionId, async snapshot => {
      await this.send(sessionId, snapshot, {});
      const entries = await this.options.ledger.entries();
      for (const [key, open] of [...this.pendingOpens]) {
        if (open.sessionId !== sessionId) continue;
        const landed = entries.find(entry => normalizedNotificationKey(entry.requested.key) === key);
        if (landed !== undefined && landed.outcome === undefined) continue;
        this.pendingOpens.delete(key);
        await this.send(sessionId, snapshot, { opened: open.agendaId, exceptDevice: open.exceptDevice, only: key });
      }
    }).catch(() => undefined);
  }

  /**
   * At start: every session with an alert no clear has covered is looked at once, for a board that changed while this
   * daemon was down or before an observer ran. Total.
   */
  async sweep(): Promise<void> {
    const entries = await this.options.ledger.entries().catch(() => []);
    const sessions = new Set(
      entries.flatMap(entry => (entry.requested.origin === 'direct' ? [] : [entry.requested.sessionId])),
    );
    for (const sessionId of sessions) if (uncoveredAlerts(sessionId, entries).length > 0) await this.recheck(sessionId);
  }

  /** The owner opened `agendaId` on the device `exceptDevice` names: its alerts come down everywhere else. */
  async seen(sessionId: string, agendaId: string, exceptDevice?: string): Promise<AlertSeenOutcome> {
    return await this.run(sessionId, async snapshot => {
      if (![...snapshot.items, ...snapshot.resolved].some(item => item.id === agendaId)) return { found: false };
      for (const key of inFlightAlerts(sessionId, agendaId, await this.options.ledger.entries()))
        this.remember(key, { sessionId, agendaId, ...(exceptDevice === undefined ? {} : { exceptDevice }) });
      return {
        found: true,
        tags: await this.send(sessionId, snapshot, {
          opened: agendaId,
          ...(exceptDevice === undefined ? {} : { exceptDevice }),
        }),
      };
    });
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

  private async run<T>(sessionId: string, work: (snapshot: AgendaSnapshot) => Promise<T>): Promise<T> {
    return await this.options.serial.run(`agenda-clear:${sessionId}`, async () => {
      const now = this.options.clock.now();
      const ledger = (await this.options.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, now);
      return await work(agendaSnapshot(ledger));
    });
  }

  /** Records and sends every clear the board calls for now; the tags they named. */
  private async send(sessionId: string, snapshot: AgendaSnapshot, how: SendOptions): Promise<readonly string[]> {
    const uncovered = uncoveredAlerts(sessionId, await this.options.ledger.entries()).filter(
      alert => how.only === undefined || pushKeyOf(alert) === how.only,
    );
    const clears = alertsToClear(sessionId, uncovered, snapshot, how.opened);
    for (const clear of clears) {
      const key = clearNotificationKey(sessionId, clear.covers);
      await this.options.ledger.append(
        NotificationRecordSchema.parse({
          v: 1,
          phase: 'requested',
          key,
          at: this.options.clock.now(),
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
          ...(how.exceptDevice === undefined ? {} : { exceptDevice: how.exceptDevice }),
        })
        .catch(() => undefined);
    }
    return clears.flatMap(clear => clear.tags);
  }
}

/** The most opens remembered while their pushes are on their way. */
const MAX_PENDING_OPENS = 256;

interface PendingOpen {
  readonly sessionId: string;
  readonly agendaId: string;
  readonly exceptDevice?: string | undefined;
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

/** The keys of one item's pushes that are recorded as requested and have no outcome yet: on their way. */
function inFlightAlerts(sessionId: string, agendaId: string, entries: readonly NotificationLedgerEntry[]): string[] {
  return entries.flatMap(({ requested, outcome }) =>
    (requested.origin === 'agenda' || requested.origin === 'attention') &&
    requested.sessionId === sessionId &&
    requested.agendaId === agendaId &&
    outcome === undefined
      ? [normalizedNotificationKey(requested.key)]
      : [],
  );
}

/**
 * The pushes for one session a device accepted and no clear has covered yet. A push that reached nothing, or
 * errored, has no line on any screen to take down.
 *
 * A push recorded before tags were is named by every tag it may have gone out under: an approve-on-phone push by its
 * approval's (`approval`, resolved from the board), and any other by the session's AND — as a second alert, keyed
 * `<key>#item` and covered on its own — the item's, which a high push used.
 */
export function uncoveredAlerts(
  sessionId: string,
  entries: readonly NotificationLedgerEntry[],
): readonly DeliveredAlert[] {
  const covered = new Set(
    entries.flatMap(entry => (entry.requested.origin === 'agenda-clear' ? entry.requested.covers : [])),
  );
  return entries.flatMap((entry): DeliveredAlert[] => {
    const { requested, outcome } = entry;
    if (requested.origin !== 'agenda' && requested.origin !== 'attention') return [];
    if (requested.sessionId !== sessionId) return [];
    if (outcome === undefined || outcome.error !== undefined || outcome.delivered === 0) return [];
    const key = normalizedNotificationKey(requested.key);
    const base = { agendaId: requested.agendaId, stop: requested.stoppedAt !== undefined };
    const alerts: DeliveredAlert[] =
      requested.tag !== undefined
        ? [{ key, ...base, tag: requested.tag }]
        : requested.phoneApproval !== undefined
          ? [{ key, ...base, approval: true }]
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
