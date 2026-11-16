import {
  agendaState,
  agendaTitle,
  type AskBoardSnapshot,
  parseCardAgendaReference,
  parseGateFollowupReference,
} from '@ferretry/core-asks/contract';
import { AGENDA_NUDGE_MARK, nothingTyped } from './turn-nudge.ts';

/**
 * THE SILENCE NUDGE (docs/agenda.md § States), as v4's `rest-nudge.ts` did it. An item the owner replied to or answered
 * RESTS, waiting on its ferret. A ferret that stays silent on one for {@link AGENDA_REST_NUDGE_MS} is nudged, then again
 * on a doubling backoff, so an owner's reply is never left unanswered in a list nobody reads.
 *
 * - **Only `waiting-on-ferret`.** A ferret that took the item on (`rest --why`, `working`) said what it is doing: never
 *   nudged. A snoozed item is the owner's. A notice, and a card the daemon raised for nobody's ferret, are not the
 *   ferret's to answer.
 * - **One message per ferret per sweep.** Every item of one ferret that is due goes in ONE message.
 * - **HARD CAP: {@link AGENDA_REST_NUDGE_LIMIT} nudges per item per rest** (v4 had none: it nudged daily for ever). A
 *   count is written BEFORE its send ({@link RestNudgeStore.reserve}) and given back only when the send is KNOWN to have
 *   typed nothing ({@link nothingTyped}), so a restart, a crash or an unconfirmed send never lets a ferret that never
 *   answers be nudged more often than that. A new rest (the owner replies again) is the owner's act, with its own count.
 * - **No chain.** The words start with {@link AGENDA_NUDGE_MARK}, so a turn they start is never turn-end checked, and
 *   they are Agenda's own sends, so they do not reset the turn-end check's cap.
 *
 * Pure except {@link AgendaRestNudger}, which reads, sends and records through its ports.
 */

/** How long an item rests before its first nudge. */
export const AGENDA_REST_NUDGE_MS = 30 * 60_000;

/** The longest the backoff grows between two nudges about one item. */
export const AGENDA_REST_NUDGE_MAX_MS = 24 * 60 * 60_000;

/**
 * The most nudges one resting item gets: the backoff (30 min, 1 h, 2 h, 4 h, 8 h, 16 h) up to its first one at the
 * 24 h ceiling, about two and a half days of silence. After that the item stays on the ferret's board and the owner's.
 */
export const AGENDA_REST_NUDGE_LIMIT = 7;

/** How often the sweep looks for items whose nudge is due. */
export const REST_NUDGE_SWEEP_MS = 60_000;

/** How every rest nudge's send id begins; Conversation also knows a send as Agenda's by its author. */
export const AGENDA_REST_NUDGE_ID_PREFIX = 'agenda-rest-nudge-';

/** What `failed` is told when the prune, not any one ferret's nudge, is what failed. */
export const PRUNE_SUBJECT = 'the rest-nudge counters';

export type RestItem = AskBoardSnapshot['items'][number];

/** What was recorded of one item's nudges: the rest it was for, how many went, when the last did, and its send. */
export interface RestNudgeRecord {
  readonly since: string;
  readonly nudges: number;
  readonly at: string;
  readonly sendId: string;
}

/** Where the counters are kept: Agenda's own small state, so a restart does not reset them. */
export interface RestNudgeStore {
  /** The ferret's records by item id. */
  records(ferret: string): Promise<Readonly<Record<string, RestNudgeRecord>>>;
  /** Records `taken` (by item id) before its send; records of items not in `live` or `taken` are dropped. */
  reserve(ferret: string, taken: Readonly<Record<string, RestNudgeRecord>>, live: readonly string[]): Promise<void>;
  /** Takes back a nudge whose send typed nothing: each item still holding `sendId` returns to `prior` (or to none). */
  release(ferret: string, sendId: string, prior: Readonly<Record<string, RestNudgeRecord | undefined>>): Promise<void>;
  /**
   * Forgets what can no longer count ({@link pruneRecords}), at most one write and none when nothing is dropped. `roster`
   * is every ferret that still exists; `resting` is, for each board READ this sweep, the ids still resting on it.
   */
  prune(roster: readonly string[], resting: Readonly<Record<string, readonly string[]>>): Promise<void>;
}

/** Every ferret's records, by ferret then by item id. */
export type RestNudgeRecords = Readonly<Record<string, Readonly<Record<string, RestNudgeRecord>>>>;

/**
 * The records left after dropping what can no longer count, or `all` itself (the same object) when nothing is dropped. A ferret not on the
 * `roster` (removed, archived) loses every record. For a ferret whose board was read (a key of `resting`) only the items
 * still resting on it keep theirs, so a closed item's counter goes even when no ferret is nudged. A ferret on the roster
 * whose board was NOT read (no key) keeps everything: an unreadable board must never cost a ferret its budget.
 */
export function pruneRecords(
  all: RestNudgeRecords,
  roster: readonly string[],
  resting: Readonly<Record<string, readonly string[]>>,
): RestNudgeRecords {
  let dropped = false;
  const kept: Record<string, Readonly<Record<string, RestNudgeRecord>>> = {};
  for (const [ferret, records] of Object.entries(all)) {
    if (!roster.includes(ferret)) {
      dropped = true;
      continue;
    }
    const ids = resting[ferret];
    const left =
      ids === undefined ? records : Object.fromEntries(Object.entries(records).filter(([id]) => ids.includes(id)));
    if (Object.keys(left).length !== Object.keys(records).length) dropped = true;
    if (Object.keys(left).length > 0) kept[ferret] = left;
  }
  return dropped ? kept : all;
}

/** The record that belongs to the rest the item is in now; one from an earlier rest counts for nothing. */
const recordOf = (
  item: RestItem,
  records: Readonly<Record<string, RestNudgeRecord>>,
): { readonly since: string; readonly record: RestNudgeRecord | undefined } | undefined => {
  const view = agendaState(item);
  if (view.state !== 'resting' || view.sub !== 'waiting-on-ferret') return undefined;
  const held = records[item.id];
  return { since: view.since, record: held?.since === view.since ? held : undefined };
};

/** How many nudges the item's current rest has had: this daemon's record, or what the board itself carries. */
export function restNudgeCount(item: RestItem, records: Readonly<Record<string, RestNudgeRecord>>): number {
  const rest = recordOf(item, records);
  return rest === undefined ? 0 : Math.max(rest.record?.nudges ?? 0, item.resting?.nudges ?? 0);
}

/**
 * When an item's next nudge is due, in epoch milliseconds, or `undefined` when it gets none: it is not waiting on its
 * ferret, its rest has had {@link AGENDA_REST_NUDGE_LIMIT}, or its clock does not read. The first is
 * {@link AGENDA_REST_NUDGE_MS} after it began resting; each next one doubles the wait after the last, up to
 * {@link AGENDA_REST_NUDGE_MAX_MS}.
 */
export function restNudgeDueAt(item: RestItem, records: Readonly<Record<string, RestNudgeRecord>>): number | undefined {
  const rest = recordOf(item, records);
  if (rest === undefined) return undefined;
  const nudges = restNudgeCount(item, records);
  if (nudges >= AGENDA_REST_NUDGE_LIMIT) return undefined;
  const last = Math.max(
    ...[rest.since, rest.record?.at, item.resting?.nudgedAt].flatMap(at => (at === undefined ? [] : [Date.parse(at)])),
  );
  return Number.isFinite(last)
    ? last + Math.min(AGENDA_REST_NUDGE_MS * 2 ** nudges, AGENDA_REST_NUDGE_MAX_MS)
    : undefined;
}

/** An item the ferret speaks for: its own, and a gate follow-up or card agenda the daemon raised on its behalf. */
const spokenFor = (item: RestItem): boolean =>
  item.notice !== true &&
  (item.raisedBy === 'agent' ||
    (item.raisedBy === 'daemon' &&
      item.source === 'task' &&
      (parseGateFollowupReference(item.sourceRef) !== undefined ||
        parseCardAgendaReference(item.sourceRef) !== undefined)));

/** The items on a ferret's board whose nudge is due at `now`, oldest due first. */
export function restNudgesDue(
  items: readonly RestItem[],
  records: Readonly<Record<string, RestNudgeRecord>>,
  now: number,
): RestItem[] {
  return items
    .filter(spokenFor)
    .flatMap(item => {
      const due = restNudgeDueAt(item, records);
      return due !== undefined && due <= now ? [{ item, due }] : [];
    })
    .sort((left, right) => left.due - right.due)
    .map(({ item }) => item);
}

/** The one message a ferret is nudged with, naming every item due. Short on purpose: it starts a turn. */
export function restNudgeMessage(items: readonly RestItem[], binary: string): string {
  const named = items.map(item => `!${item.id} «${agendaTitle(item)}»`).join(', ');
  const first = items[0]?.id ?? 'A1';
  const them = items.length === 1 ? 'it' : 'each';
  return `${AGENDA_NUDGE_MARK} The owner replied on ${named} and is waiting on you. Answer ${them}: \`${binary} agenda answer ${first} "<text>"\` (back to their list), \`${binary} agenda rest ${first} --why "<what you are doing>"\` while you work on it, or \`${binary} agenda done ${first}\` when nothing more is expected.`;
}

/**
 * The send id of one nudge message: the ferret, and the FIRST item due with the rest it is in and the nudge it is. That
 * triple belongs to exactly one message, ever, so a later reply cycle of the same item is another message.
 */
export function restNudgeSendId(
  ferret: string,
  first: RestItem,
  records: Readonly<Record<string, RestNudgeRecord>>,
): string {
  const since = recordOf(first, records)?.since ?? '';
  return `${AGENDA_REST_NUDGE_ID_PREFIX}${ferret}-${first.id}.${Date.parse(since)}.${restNudgeCount(first, records) + 1}`;
}

/** What the nudge reads and how it sends. */
export interface AgendaRestNudgePorts extends RestNudgeStore {
  /** The machine's switch (`agenda.yaml` `agendaNudge`), read per sweep so turning it off is immediate. */
  readonly enabled: () => boolean;
  /** Every board that may hold a resting item. */
  readonly boards: () => Promise<readonly AskBoardSnapshot[]>;
  /** Every ferret that still exists (live or stopped, not removed or archived): the rest are forgotten by the prune. */
  readonly roster: () => Promise<readonly string[]>;
  /** Whether the ferret can be nudged now: running (a stopped or gone one never is) and Conversation there to type it. */
  readonly running: (ferret: string) => Promise<boolean>;
  /** Now, as an instant. */
  readonly now: () => string;
  /** The send; the same id twice is one message. Throws a `NudgeSendFailure` for an answer that is not an acceptance. */
  readonly send: (ferret: string, sendId: string, message: string) => Promise<void>;
  /** A ferret's nudge that failed: the sweep goes on to the next ferret. */
  readonly failed: (ferret: string, error: unknown) => void;
}

/**
 * Sweeps every board for resting items whose ferret has been silent past its nudge, and nudges each ferret once for all
 * of them. One ferret at a time, each on its own: a board that cannot be read, or a send that fails, leaves the rest
 * swept and that one for the next sweep.
 */
export class AgendaRestNudger {
  constructor(
    private readonly ports: AgendaRestNudgePorts,
    private readonly binary: string,
  ) {}

  /** Nudges every ferret with an item due; returns how many ferrets were nudged. */
  async sweep(): Promise<number> {
    if (!this.ports.enabled()) return 0;
    let nudged = 0;
    const boards = await this.ports.boards();
    for (const board of boards) {
      try {
        if (await this.nudge(board)) nudged += 1;
      } catch (error) {
        this.ports.failed(board.sessionId, error);
      }
    }
    await this.prune(boards);
    return nudged;
  }

  /**
   * Forgets the counters that can no longer count, whether or not anything was nudged: a closed item's, and a removed or
   * archived ferret's. Only a board READ this sweep speaks for its items; a ferret whose board is not among `boards`
   * keeps its budget. A failure here costs nothing but a later prune, so it is reported and never fails the sweep.
   */
  private async prune(boards: readonly AskBoardSnapshot[]): Promise<void> {
    try {
      const resting = Object.fromEntries(
        boards.map(board => [
          board.sessionId,
          board.items.filter(item => recordOf(item, {}) !== undefined).map(item => item.id),
        ]),
      );
      await this.ports.prune(await this.ports.roster(), resting);
    } catch (error) {
      this.ports.failed(PRUNE_SUBJECT, error);
    }
  }

  private async nudge(board: AskBoardSnapshot): Promise<boolean> {
    const ferret = board.sessionId;
    const records = await this.ports.records(ferret);
    const due = restNudgesDue(board.items, records, Date.parse(this.ports.now()));
    const [first] = due;
    if (first === undefined || !(await this.ports.running(ferret))) return false;
    const sendId = restNudgeSendId(ferret, first, records);
    const at = this.ports.now();
    const taken = Object.fromEntries(
      due.map(item => [
        item.id,
        { since: recordOf(item, records)?.since ?? '', nudges: restNudgeCount(item, records) + 1, at, sendId },
      ]),
    );
    const prior = Object.fromEntries(due.map(item => [item.id, records[item.id]]));
    await this.ports.reserve(
      ferret,
      taken,
      board.items.map(item => item.id),
    );
    try {
      await this.ports.send(ferret, sendId, restNudgeMessage(due, this.binary));
    } catch (error) {
      if (nothingTyped(error)) await this.ports.release(ferret, sendId, prior).catch(() => undefined);
      throw error;
    }
    return true;
  }
}
