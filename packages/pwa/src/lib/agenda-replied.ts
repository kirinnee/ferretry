/**
 * A REPLY MOVES THE INBOX ON AT ONCE.
 *
 * The daemon parks an item the owner replied to (`parked: { reason: 'replied' }`) the moment the chat message is
 * accepted, but the Inbox learns it from the NEXT board read. Until then the card stayed on the deck, "Answer
 * quickly" could deal it again, and the badge still counted it. This is the owner's side of that gap: the moment a
 * reply from the Inbox card composer is accepted the item is marked replied HERE, as a small overlay on what the
 * boards say, and it is dropped once a board read agrees with it.
 *
 * Nothing in the overlay is a fact the daemon does not already hold: the daemon parked the item, this only hides it
 * sooner. So it never outlives its usefulness — it is dropped when the board agrees, when the ferret asks again
 * (the ferret's new ask wins), and at the latest after {@link REPLIED_OVERLAY_TTL_MS}.
 *
 * UNDO is not a second send. The message is already with the daemon, so Undo does two things the owner can do by
 * hand: it takes the message back out of the session queue while the ferret has not read it (and gives the words
 * back to the composer), and it brings the item back to the list (the owner `unsnooze` the board already has). A
 * ferret that already took the message cannot be un-told: Undo then only brings the card back, and says so.
 *
 * PURE where it can be ({@link withRepliedCards}, {@link withRepliedParked}, {@link repliedAgrees}); the one class
 * holds the entries and the two ports it needs to take things back.
 */

import { type AgendaItem, openCardAsks } from '@ferretry/protocol';
import { browserDeferredTimers, type DeferredTimers, type InboxCard, UNDO_WINDOW_MS } from './agenda-inbox.ts';
import { isGateItem } from './gate-items.ts';

/** How long the overlay may outlast a board that never agrees (an older machine that did not park the item). */
const REPLIED_OVERLAY_TTL_MS = 30_000;

/** How long the sentence about what Undo did stays in the toast. */
const REPLIED_NOTICE_MS = 6_000;

/** What the composer knew when its send was accepted. */
export interface RepliedMessage {
  /** The owner's own words (what the box held), without the `!A5` prefix the chat message carries. */
  readonly words: string;
  /** The id the message is queued under, when the send reported or chose one. */
  readonly sendId?: string | undefined;
  /** What the transport did at once: `delivered` means the ferret already has it. */
  readonly disposition?: string | undefined;
}

/** `replied`: hidden from the list, parked in Replied. `back`: Undo brought it back, shown again until a board agrees. */
type RepliedPhase = 'replied' | 'back';

export interface RepliedEntry {
  readonly key: string;
  /** The card as it was when the owner replied: what Replied lists and what comes back on Undo. */
  readonly card: InboxCard;
  readonly phase: RepliedPhase;
  readonly repliedAt: number;
  /** The item's `waitingSince` at the reply: a board that shows a different one shows the ferret asking again. */
  readonly waitingSince: string;
  readonly words: string;
  /** The queue id Undo takes back; absent when the send gave none (Undo then cannot tell what the ferret read). */
  readonly sendId?: string;
  /** The ferret already took the message when it was accepted: there is nothing to withdraw. */
  readonly taken: boolean;
  /** Undo is offered in the toast until this instant. */
  readonly undoUntil: number;
  /** In `back`: the unsnooze settled, so a board that lists the item open is the truth again. */
  readonly settled: boolean;
  /** Undo asked the deck to open this card: the page does it once and clears it. */
  readonly reveal: boolean;
}

/** What Undo did, said once in the toast. */
type RepliedNoticeKind =
  /** The message was taken back; the words are in the composer (or there were none). */
  | 'withdrawn'
  /** The ferret already read the reply: only the card came back. */
  | 'read'
  /** The reply could not be told from read: only the card came back. */
  | 'unknown'
  /** The queue refused or could not be reached: the reply may still reach the ferret. */
  | 'refused'
  /** The card could not be put back on the list. */
  | 'not-back';

export interface RepliedNotice {
  readonly key: string;
  /** The card Undo was for: the toast names its ferret from it. */
  readonly card: InboxCard;
  readonly kind: RepliedNoticeKind;
  /** The machine's reason, for `refused` and `not-back`. */
  readonly message?: string;
  readonly until: number;
}

/** Words to put back into a card's composer; the composer takes them once. */
interface RepliedRestore {
  readonly key: string;
  readonly text: string;
}

export interface RepliedState {
  readonly entries: readonly RepliedEntry[];
  readonly notice: RepliedNotice | null;
  readonly restores: readonly RepliedRestore[];
}

/** `withdrawn`: it was still waiting and is gone. `taken`: the ferret already has it. A refusal throws. */
export type Withdrawal = 'withdrawn' | 'taken';

/** What taking a reply back needs from the machine; the shell wires them to the queue route and the board. */
export interface RepliedPorts {
  /** Takes the queued message out of the session's queue. Throws when the queue cannot be reached. */
  readonly withdraw: (card: InboxCard, sendId: string) => Promise<Withdrawal>;
  /** The owner's `unsnooze`: the item is back on the owner's list now. Throws with the machine's reason. */
  readonly unsnooze: (card: InboxCard) => Promise<void>;
}

/** A transport disposition that means the agent already has the message. */
const TAKEN_DISPOSITIONS: ReadonlySet<string> = new Set(['delivered', 'sent', 'revived']);

const reasonOf = (reason: unknown, fallback: string): string => (reason instanceof Error ? reason.message : fallback);

const EMPTY: RepliedState = { entries: [], notice: null, restores: [] };

/** What a board says about a replied item: the item, `null` when the board is read and holds no open item of that id, or `undefined` when it is not read. */
export type BoardItemRead = AgendaItem | null | undefined;

/**
 * Whether the boards have caught up with an entry, so the overlay can go.
 *
 * - `replied`: the board shows the item parked or gone (the daemon did what the overlay said), or open under a NEW
 *   ask (`waitingSince` moved: the ferret brought it back, and its ask wins over the owner's reply).
 * - `back`: after the unsnooze settled, the open list holds it again (`listed`), or the board no longer has it.
 *
 * `undefined` (a board not read) agrees with nothing.
 */
export const repliedAgrees = (entry: RepliedEntry, read: BoardItemRead, listed: boolean): boolean => {
  if (entry.phase === 'back') return read === null || (entry.settled && listed);
  if (read === undefined) return false;
  if (read === null) return true;
  return read.parked !== undefined || read.waitingSince !== entry.waitingSince;
};

const waitingOrder = (left: InboxCard, right: InboxCard): number =>
  Date.parse(right.item.waitingSince) - Date.parse(left.item.waitingSince) || left.key.localeCompare(right.key);

/**
 * The deck's cards with the overlay applied: a card the owner replied to is gone, and one Undo brought back is
 * there, without its parked mark, even while the boards still hold it parked. `cards` is what the boards say.
 */
export const withRepliedCards = (cards: readonly InboxCard[], state: RepliedState): readonly InboxCard[] => {
  if (state.entries.length === 0) return cards;
  const replied = new Set(state.entries.filter(entry => entry.phase === 'replied').map(entry => entry.key));
  const kept = cards.filter(card => !replied.has(card.key));
  const have = new Set(kept.map(card => card.key));
  const back = state.entries.flatMap(entry => {
    if (entry.phase !== 'back' || have.has(entry.key)) return [];
    const { parked: _parked, ...item } = entry.card.item;
    return [{ ...entry.card, item: item as AgendaItem }];
  });
  return back.length === 0 ? kept : [...kept, ...back].sort(waitingOrder);
};

/**
 * The Replied list with the overlay applied: a card the owner just replied to is already there, parked "now", and
 * one Undo brought back is not. `parked` is what the boards say.
 */
export const withRepliedParked = (parked: readonly InboxCard[], state: RepliedState): readonly InboxCard[] => {
  if (state.entries.length === 0) return parked;
  const back = new Set(state.entries.filter(entry => entry.phase === 'back').map(entry => entry.key));
  const kept = parked.filter(card => !back.has(card.key));
  const have = new Set(kept.map(card => card.key));
  const added = state.entries.flatMap(entry =>
    entry.phase !== 'replied' || have.has(entry.key)
      ? []
      : [
          {
            ...entry.card,
            item: {
              ...entry.card.item,
              parked: { reason: 'replied' as const, at: new Date(entry.repliedAt).toISOString() },
            },
          },
        ],
  );
  if (added.length === 0 && kept.length === parked.length) return parked;
  return [...added, ...kept].sort(
    (left, right) =>
      Date.parse(right.item.parked?.at ?? '') - Date.parse(left.item.parked?.at ?? '') ||
      left.key.localeCompare(right.key),
  );
};

/**
 * An item a reply parks: not a notice (read, never replied to), not a gate item (only the owner's answer moves it), and
 * not one with a card ask still waiting on the owner (a try-it behind a question the owner just answered in words): the
 * daemon keeps that item in Needs you — the one rule it rests by (`restedOnAnswer`) — so hiding it here would hide the
 * try-it that is now the ask.
 */
export const parksOnReply = (item: AgendaItem): boolean =>
  item.notice !== true && !isGateItem(item) && !openCardAsks(item).some(ask => ask.notYet === undefined);

export class RepliedAgenda {
  #state: RepliedState = EMPTY;
  readonly #expiry = new Map<string, unknown>();
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly ports: RepliedPorts,
    private readonly timers: DeferredTimers = browserDeferredTimers,
    private readonly undoMs: number = UNDO_WINDOW_MS,
    private readonly ttlMs: number = REPLIED_OVERLAY_TTL_MS,
    private readonly noticeMs: number = REPLIED_NOTICE_MS,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): RepliedState => this.#state;

  /** The reply to `card` was accepted: the item leaves the list now. Returns false for an item a reply does not park. */
  mark(card: InboxCard, sent: RepliedMessage): boolean {
    if (!parksOnReply(card.item)) return false;
    const now = this.timers.now();
    const entry: RepliedEntry = {
      key: card.key,
      card,
      phase: 'replied',
      repliedAt: now,
      waitingSince: card.item.waitingSince,
      words: sent.words,
      ...(sent.sendId === undefined ? {} : { sendId: sent.sendId }),
      taken: sent.disposition !== undefined && TAKEN_DISPOSITIONS.has(sent.disposition),
      undoUntil: now + this.undoMs,
      settled: false,
      reveal: false,
    };
    this.#arm(card.key);
    this.#publish({
      ...this.#state,
      entries: [...this.#state.entries.filter(each => each.key !== card.key), entry],
      restores: this.#state.restores.filter(each => each.key !== card.key),
    });
    return true;
  }

  /** The newest reply Undo can still take back, if the toast is offering one. */
  undoable(now: number = this.timers.now()): RepliedEntry | undefined {
    return this.#state.entries.findLast(entry => entry.phase === 'replied' && entry.undoUntil > now);
  }

  /**
   * Takes the reply back: the card is on the list again at once, then the message is withdrawn if the ferret has
   * not read it (its words go back to the composer) and the item is unsnoozed on the machine.
   */
  async undo(key?: string): Promise<void> {
    const entry =
      key === undefined
        ? this.undoable()
        : this.#state.entries.find(each => each.key === key && each.phase === 'replied');
    if (entry === undefined) return;
    this.#arm(entry.key);
    this.#replace({ ...entry, phase: 'back', reveal: true });

    let kind: RepliedNoticeKind = 'unknown';
    let message: string | undefined;
    let restore = '';
    if (entry.taken) kind = 'read';
    else if (entry.sendId !== undefined) {
      try {
        const outcome = await this.ports.withdraw(entry.card, entry.sendId);
        if (outcome === 'withdrawn') {
          kind = 'withdrawn';
          restore = entry.words;
        } else kind = 'read';
      } catch (reason) {
        kind = 'refused';
        message = reasonOf(reason, 'The queue could not be reached.');
      }
    }
    // The words are put back BEFORE the card is asked back: they are the one thing that cannot be got again.
    if (restore.trim() !== '') {
      this.#publish({
        ...this.#state,
        restores: [...this.#state.restores.filter(each => each.key !== entry.key), { key: entry.key, text: restore }],
      });
    }
    try {
      await this.ports.unsnooze(entry.card);
      this.#replace({ ...this.#current(entry.key, entry), settled: true });
      this.#say({ key: entry.key, card: entry.card, kind, ...(message === undefined ? {} : { message }) });
    } catch (reason) {
      this.#drop(entry.key);
      this.#say({
        key: entry.key,
        card: entry.card,
        kind: 'not-back',
        message: reasonOf(reason, 'The machine did not accept it.'),
      });
    }
  }

  /** The page opened the card Undo brought back. */
  revealed(key: string): void {
    const entry = this.#state.entries.find(each => each.key === key);
    if (entry === undefined || !entry.reveal) return;
    this.#replace({ ...entry, reveal: false });
  }

  /** The words waiting for this card's composer, taken: they are given once. */
  takeRestore(key: string): string | undefined {
    const found = this.#state.restores.find(each => each.key === key);
    if (found === undefined) return undefined;
    this.#publish({ ...this.#state, restores: this.#state.restores.filter(each => each.key !== key) });
    return found.text;
  }

  /** Drops every entry the boards now agree with. `read` is what the board holds for a card; `listed` is the deck as the boards deal it. */
  reconcile(read: (card: InboxCard) => BoardItemRead, listed: ReadonlySet<string>): void {
    const gone = this.#state.entries.filter(entry => repliedAgrees(entry, read(entry.card), listed.has(entry.key)));
    if (gone.length === 0) return;
    for (const entry of gone) this.#disarm(entry.key);
    const keys = new Set(gone.map(entry => entry.key));
    this.#publish({ ...this.#state, entries: this.#state.entries.filter(entry => !keys.has(entry.key)) });
  }

  /** Forgets the notice once the toast has shown it. */
  clearNotice(): void {
    if (this.#state.notice !== null) this.#publish({ ...this.#state, notice: null });
  }

  #current(key: string, fallback: RepliedEntry): RepliedEntry {
    return this.#state.entries.find(each => each.key === key) ?? fallback;
  }

  #say(notice: Omit<RepliedNotice, 'until'>): void {
    this.#publish({ ...this.#state, notice: { ...notice, until: this.timers.now() + this.noticeMs } });
  }

  #replace(entry: RepliedEntry): void {
    if (!this.#state.entries.some(each => each.key === entry.key)) return;
    this.#publish({
      ...this.#state,
      entries: this.#state.entries.map(each => (each.key === entry.key ? entry : each)),
    });
  }

  #drop(key: string): void {
    this.#disarm(key);
    this.#publish({ ...this.#state, entries: this.#state.entries.filter(each => each.key !== key) });
  }

  #arm(key: string): void {
    this.#disarm(key);
    this.#expiry.set(
      key,
      this.timers.setTimeout(() => this.#drop(key), this.ttlMs),
    );
  }

  #disarm(key: string): void {
    const handle = this.#expiry.get(key);
    if (handle !== undefined) this.timers.clearTimeout(handle);
    this.#expiry.delete(key);
  }

  #publish(state: RepliedState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
