import { AGENDA_REST_NUDGE_MS, type AgendaItem, agendaState, agendaTitle } from '@ferretry/protocol';
import type { AgendaSweepTimers } from './resurfacer.ts';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { type AgendaNudgeTarget, agendaSnapshot, isOnBehalfItem } from './state-machine.ts';
import { AGENDA_NUDGE_MARK } from './turn-nudge.ts';

/**
 * THE SILENCE NUDGE (docs/agenda.md § States): an item the owner replied to or answered RESTS, waiting on its ferret.
 * A ferret that stays silent on one for {@link AGENDA_REST_NUDGE_MS} is nudged by the Warden, once, then again on a
 * doubling backoff — so an owner's reply is never left unanswered in a list nobody reads.
 *
 * - **Only `waiting-on-ferret`.** A ferret that took the item on (`rest --why`, `working`) said what it is doing:
 *   it is never nudged. A snoozed item is the owner's.
 * - **One message per ferret per sweep, never a burst.** Every item of one ferret that is due goes in ONE message.
 * - **An item migrated from before Resting is nudged once** (`resting.migrated`), never again, so the upgrade's
 *   backlog of old replies costs each ferret one message.
 * - **Exactly once per due nudge.** The send id names the first item due, the rest it is in (when it began) and its
 *   nudge count, so the same nudge in a later reply cycle is a different message. The Warden records that id on every
 *   item of the message BEFORE it sends, and a sweep after a restart resumes the recorded message: whichever items
 *   the crash left unrecorded are recorded under the same id, which the send path deduplicates, so no item is nudged
 *   twice. The record moves each item's backoff on, and only the rest it was sent for: a reply that arrived while the
 *   send was in flight starts a new rest, with its own first nudge.
 * - **Off with the turn-end check** (the machine's `attentionNudge`), and journalled as a nudge with the items named.
 *
 * Pure except {@link AgendaRestNudger}, which reads, sends and records through its ports.
 */

/** The longest the backoff grows between two nudges about one item. */
export const AGENDA_REST_NUDGE_MAX_MS = 24 * 60 * 60_000;

/** How often the sweep looks for items whose nudge is due. */
export const REST_NUDGE_SWEEP_MS = 60_000;

/**
 * When an item's next nudge is due, in epoch milliseconds, or `undefined` when it gets none: it is not waiting on its
 * ferret, or it was migrated and has had its one. The first is {@link AGENDA_REST_NUDGE_MS} after it began resting;
 * each next one doubles the wait after the last, up to {@link AGENDA_REST_NUDGE_MAX_MS}.
 */
export function restNudgeDueAt(item: AgendaItem): number | undefined {
  const view = agendaState(item);
  if (view.state !== 'resting' || view.sub !== 'waiting-on-ferret') return undefined;
  const nudges = item.resting?.nudges ?? 0;
  if (item.resting?.migrated === true && nudges > 0) return undefined;
  const last = Date.parse(item.resting?.nudgedAt ?? view.since);
  const wait = Math.min(AGENDA_REST_NUDGE_MS * 2 ** nudges, AGENDA_REST_NUDGE_MAX_MS);
  return Number.isFinite(last) ? last + wait : undefined;
}

/** The items on a ferret's board whose nudge is due at `now`, oldest rest first. */
export function restNudgesDue(items: readonly AgendaItem[], now: number): AgendaItem[] {
  return (
    items
      // Only what the ferret speaks for: its own items and a gate's follow-up; the daemon's own cards are not its to answer.
      .filter(item => item.notice !== true && (item.raisedBy === 'agent' || isOnBehalfItem(item)))
      .filter(item => {
        const due = restNudgeDueAt(item);
        return due !== undefined && due <= now;
      })
      .sort((left, right) => (restNudgeDueAt(left) ?? 0) - (restNudgeDueAt(right) ?? 0))
  );
}

/** The one message a ferret is nudged with, naming every item due. Short on purpose: it starts a turn. */
export function restNudgeMessage(items: readonly AgendaItem[], binary: string): string {
  const named = items.map(item => `!${item.id} «${agendaTitle(item)}»`).join(', ');
  const first = items[0]?.id ?? 'A1';
  const them = items.length === 1 ? 'it' : 'each';
  return `${AGENDA_NUDGE_MARK} The owner replied on ${named} and is waiting on you. Answer ${them}: \`${binary} agenda answer ${first} "<text>"\` (back to their list), \`${binary} agenda rest ${first} --why "<what you are doing>"\` while you work on it, or \`${binary} agenda done ${first}\` when nothing more is expected.`;
}

/** What the Warden saw of one resting item: the rest it is in, and the nudges it has had. */
export function restNudgeTarget(item: AgendaItem): AgendaNudgeTarget {
  const view = agendaState(item);
  return { id: item.id, since: view.state === 'resting' ? view.since : '', nudges: item.resting?.nudges ?? 0 };
}

/**
 * The send id of one nudge message: the session, and the FIRST item due with the rest it is in and the nudge it is.
 * That triple belongs to exactly one message, ever — a later reply cycle of the same item has another rest.
 */
export function restNudgeSendId(sessionId: string, items: readonly AgendaItem[]): string {
  const first = items[0];
  const target = first === undefined ? undefined : restNudgeTarget(first);
  return `agenda-rest-nudge-${sessionId}-${target?.id ?? 'none'}.${Date.parse(target?.since ?? '')}.${(target?.nudges ?? 0) + 1}`;
}

/** What the nudge reads and how it sends. */
export interface AgendaRestNudgePorts {
  /** The machine's switch (`machine.yaml` `attentionNudge`), read per sweep so turning it off is immediate. */
  readonly enabled: () => Promise<boolean>;
  /** The ordinary send; the same id twice is one message. */
  readonly send: (sessionId: string, sendId: string, message: string) => Promise<void>;
  /** Journals that a nudge went out, with the items it named. */
  readonly record: (sessionId: string, asks: readonly string[]) => Promise<void>;
}

/**
 * Sweeps every board for resting items whose ferret has been silent past its nudge, and nudges each ferret once for
 * all of them. One session at a time, each on its own: a board that cannot be read, or a send that fails, leaves the
 * rest swept and that one for the next sweep (nothing is recorded for a nudge that did not go).
 */
export class AgendaRestNudger {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'nudging' | 'nudged'>,
    private readonly ports: AgendaRestNudgePorts,
    private readonly sessionIds: () => readonly string[],
    private readonly timers: AgendaSweepTimers,
    private readonly now: () => string,
    private readonly binary: string,
    private readonly sweepMs: number = REST_NUDGE_SWEEP_MS,
  ) {}

  /** Begins sweeping, now and then every `sweepMs`. */
  start(): void {
    void this.tick();
  }

  stop(): void {
    this.timers.cancel('agenda-rest-nudge');
  }

  /** Nudges every ferret with an item due; returns how many ferrets were nudged. Total. */
  async sweep(): Promise<number> {
    if (!(await this.ports.enabled().catch(() => false))) return 0;
    const now = Date.parse(this.now());
    let nudged = 0;
    for (const sessionId of this.sessionIds()) {
      try {
        const ledger = await this.boards.read(sessionId);
        if (ledger === null) continue;
        const due = restNudgesDue(agendaSnapshot(ledger).items, now);
        if (due.length === 0) continue;
        const batch = await this.plan(sessionId, due);
        if (batch === undefined) continue;
        await this.ports.send(sessionId, batch.sendId, restNudgeMessage(batch.items, this.binary));
        for (const item of batch.items) await this.agenda.nudged(sessionId, restNudgeTarget(item));
        await this.ports
          .record(
            sessionId,
            batch.items.map(item => `waiting on you !${item.id}`),
          )
          .catch(() => undefined);
        nudged += 1;
      } catch {
        // One ferret's board or send failing leaves the others nudged; this one is looked at again next sweep.
      }
    }
    return nudged;
  }

  /**
   * The one message this sweep sends. A message already decided on (an item carries its send id) is finished first,
   * with the items it still has to reach; otherwise the due items become a new message, recorded before it is sent.
   */
  private async plan(
    sessionId: string,
    due: readonly AgendaItem[],
  ): Promise<{ readonly sendId: string; readonly items: readonly AgendaItem[] } | undefined> {
    const decided = due.find(item => item.resting?.nudgeSend !== undefined)?.resting?.nudgeSend;
    if (decided !== undefined) {
      return { sendId: decided, items: due.filter(item => item.resting?.nudgeSend === decided) };
    }
    const sendId = restNudgeSendId(sessionId, due);
    const marked = await this.agenda.nudging(sessionId, due.map(restNudgeTarget), sendId);
    if (!marked.ok) throw new Error(marked.error.message);
    return marked.changed ? { sendId, items: due } : undefined;
  }

  private async tick(): Promise<void> {
    await this.sweep().catch(() => 0);
    this.timers.schedule('agenda-rest-nudge', this.sweepMs, () => {
      void this.tick();
    });
  }
}
