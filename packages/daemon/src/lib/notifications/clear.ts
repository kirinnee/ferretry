import type { AgendaSnapshot, PushPayload } from '@ferretry/protocol';
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
  constructor(private readonly options: AgendaAlertClearerOptions) {}

  async changed(sessionId: string, _change: AgendaBoardChange): Promise<void> {
    await this.run(sessionId, async snapshot => await this.send(sessionId, snapshot, undefined, undefined)).catch(
      () => undefined,
    );
  }

  /** The owner opened `agendaId` on the device `exceptDevice` names: its alerts come down everywhere else. */
  async seen(sessionId: string, agendaId: string, exceptDevice?: string): Promise<AlertSeenOutcome> {
    return await this.run(sessionId, async snapshot => {
      if (![...snapshot.items, ...snapshot.resolved].some(item => item.id === agendaId)) return { found: false };
      return { found: true, tags: await this.send(sessionId, snapshot, agendaId, exceptDevice) };
    });
  }

  private async run<T>(sessionId: string, work: (snapshot: AgendaSnapshot) => Promise<T>): Promise<T> {
    return await this.options.serial.run(`agenda-clear:${sessionId}`, async () => {
      const now = this.options.clock.now();
      const ledger = (await this.options.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, now);
      return await work(agendaSnapshot(ledger));
    });
  }

  /** Records and sends every clear the board calls for now; the tags they named. */
  private async send(
    sessionId: string,
    snapshot: AgendaSnapshot,
    opened: string | undefined,
    exceptDevice: string | undefined,
  ): Promise<readonly string[]> {
    const clears = alertsToClear(
      sessionId,
      uncoveredAlerts(sessionId, await this.options.ledger.entries()),
      snapshot,
      opened,
    );
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
          ...(opened === undefined ? {} : { opened }),
          covers: clear.covers,
          tags: clear.tags,
          enrolled: 0,
        }),
      );
      await this.options.push
        .notify({
          payload: clearPushPayload(sessionId, key, clear.tags),
          ...(exceptDevice === undefined ? {} : { exceptDevice }),
        })
        .catch(() => undefined);
    }
    return clears.flatMap(clear => clear.tags);
  }
}

/**
 * The pushes for one session a device accepted and no clear has covered yet. A push that reached nothing, or
 * errored, has no line on any screen to take down.
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
    if (covered.has(key)) return [];
    return [
      {
        key,
        agendaId: requested.agendaId,
        stop: requested.stoppedAt !== undefined,
        ...(requested.tag === undefined ? {} : { tag: requested.tag }),
      },
    ];
  });
}
