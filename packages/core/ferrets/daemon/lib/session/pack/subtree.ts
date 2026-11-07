/**
 * THE SUBTREE TABLE A LEAD READS (`GET /v1/sessions/:sessionId/subtree`, docs/pack-mode.md).
 *
 * Everything here is read from what the daemon already holds — the sessions registry, the board's cards (which
 * carry the PR cache the watcher keeps; nothing here calls GitHub) and each ferret's outbox — in ONE pass, so a
 * lead with fifty descendants costs one request, one board read and one small file read per descendant.
 *
 * THE EXCERPTS ARE REDACTED BEFORE THEY ARE CUT. A note or a message is arbitrary text a ferret wrote, so it can
 * quote a vault secret or a just-typed value; the whole candidate goes through the injected redactor (one batch
 * for the table) and only then to one line, because masking after the cut misses a secret that straddles it. If
 * the redactor fails, no excerpt is shown at all ({@link EXCERPT_WITHHELD}), never the raw text.
 *
 * THE OUTBOX READS ARE BOUNDED. At most {@link SubtreeLimits.concurrency} files are open at once, at most
 * {@link SubtreeLimits.excerptRows} rows (of which {@link SubtreeLimits.endedRows} may be ended ones) get an
 * excerpt and no more than {@link SubtreeLimits.outboxBytes} bytes are read in all. A row past a budget is
 * listed without an excerpt; the table never fails for being large.
 *
 * Lineage comes from the registry's `parent` links and nothing else: the request names only the root. The
 * messages shown are those sent to the AUTHENTICATED CALLER (derived by the route, never read from the
 * request), which is the root itself only when no ferret is asking — the owner at the machine.
 */
import {
  type BoardTask,
  displayModel,
  formatTaskRef,
  type PrLink,
  parentOf,
  SESSION_ENDED_STATUSES,
  type SessionView,
  SUBTREE_ENDED_WINDOW_MS,
  SUBTREE_LAST_LINE_MAX,
  type SubtreeRow,
  type SubtreeState,
  type SubtreeView,
  sessionsById,
  subtreeDepths,
} from '@ferretry/protocol';
import type { LaneSets } from '../../board/graph.ts';
import { mapBounded } from './bounded.ts';

/** One member of the subtree, in tree order. */
export interface SubtreeMember {
  readonly view: SessionView;
  readonly depth: number;
}

/** The newest message a ferret sent to the asking lead. */
export interface SentMessage {
  readonly at: string;
  readonly text: string;
}

/** What one outbox lookup found, and how many bytes it had to read to find it (charged to the table's budget). */
export interface OutboxLookup {
  readonly message: SentMessage | undefined;
  readonly scanned: number;
}

/** The text shown in place of an excerpt that could not be redacted. */
export const EXCERPT_WITHHELD = '[excerpt withheld]';

/** The bounds on one table's excerpt work. */
export interface SubtreeLimits {
  /** Outbox files read at the same time. */
  readonly concurrency: number;
  /** Rows that get an excerpt at all; the rest are listed without one. Live rows are served before ended ones. */
  readonly excerptRows: number;
  /** Of those rows, how many may be recently ended ones. */
  readonly endedRows: number;
  /** Outbox bytes read across the whole table. */
  readonly outboxBytes: number;
  /** Outbox bytes read for any one row. */
  readonly rowBytes: number;
}

export const SUBTREE_LIMITS: SubtreeLimits = {
  concurrency: 4,
  excerptRows: 64,
  endedRows: 8,
  outboxBytes: 8 * 1024 * 1024,
  rowBytes: 1024 * 1024,
};

export interface SubtreePorts {
  sessions(): Promise<readonly SessionView[]>;
  /** Every card as stored, with each board's lanes: one store read. */
  board(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }>;
  /** The newest message `sessionId` sent to `to` (if any), reading at most `maxBytes` of its outbox. */
  lastMessage(sessionId: string, to: string, maxBytes: number): Promise<OutboxLookup>;
  /**
   * Masks every secret in each text, in order, under ONE vault open. It rejects when it cannot be sure (the
   * vault will not open), and the table then withholds its excerpts rather than show text it did not scrub.
   */
  redact(texts: readonly string[]): Promise<readonly string[]>;
  nowMs(): number;
}

const callsignOf = (view: SessionView): string => view.config.teammate?.trim() || view.config.name || view.config.id;

/** When a settled session ended, as far as the registry knows; `undefined` when it never said. */
const endedAtOf = (view: SessionView): string | undefined => view.state.finishedAt ?? view.state.lastActivityAt;

const isEnded = (view: SessionView): boolean => SESSION_ENDED_STATUSES.has(view.state.status);

/** The first non-blank line of `text`, whitespace collapsed and cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number = SUBTREE_LAST_LINE_MAX): string {
  const first =
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? '';
  const collapsed = first.replace(/\s+/gu, ' ');
  const characters = [...collapsed];
  return characters.length <= max
    ? collapsed
    : `${characters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * How a session is doing, in a lead's words. `needs-you` is a session stuck on a person (an open question, an
 * item on the owner's agenda, a flagged need); `waiting` is a deliberate park or a rate limit it sits out.
 */
export function subtreeStateOf(view: SessionView): SubtreeState {
  const { state } = view;
  if (isEnded(view)) return 'ended';
  const agenda = state.agenda;
  const onOwner = agenda !== undefined && agenda.open - (agenda.discussing ?? 0) > 0;
  if (
    state.needsHuman !== undefined ||
    state.pendingQuestion != null ||
    state.status === 'awaiting_question' ||
    state.status === 'awaiting_user' ||
    onOwner
  )
    return 'needs-you';
  if (state.waiting !== undefined || state.status === 'waiting' || state.status === 'rate_limited') return 'waiting';
  return 'running';
}

/**
 * The descendants to list: every live one, and every one that ended inside `windowMs`, in tree order (a ferret,
 * then its own sub-ferrets, then the next sibling; siblings by callsign). An ended session with no recorded end
 * time cannot be shown to be recent, so it is left out. A descendant of a left-out session still has its row.
 */
export function subtreeMembers(
  sessions: readonly SessionView[],
  rootId: string,
  nowMs: number,
  windowMs: number = SUBTREE_ENDED_WINDOW_MS,
): readonly SubtreeMember[] {
  const byId = sessionsById(sessions);
  const depths = subtreeDepths(byId, rootId);

  const recent = (view: SessionView): boolean => {
    if (!isEnded(view)) return true;
    const endedAt = endedAtOf(view);
    const endedMs = endedAt === undefined ? Number.NaN : Date.parse(endedAt);
    return !Number.isNaN(endedMs) && nowMs - endedMs <= windowMs;
  };

  // Each member's sort key is the callsigns from the root down to it, so comparing keys element by element
  // lists a ferret directly before its own descendants.
  const keyOf = (id: string): readonly string[] => {
    const key: string[] = [];
    for (let current = byId.get(id); current && current.config.id.trim() !== rootId; ) {
      key.unshift(`${callsignOf(current).toLowerCase()}\u0000${current.config.id}`);
      const parent = parentOf(current);
      current = parent === undefined ? undefined : byId.get(parent);
    }
    return key;
  };

  return [...depths]
    .filter(([id]) => id !== rootId)
    .flatMap(([id, depth]) => {
      const view = byId.get(id);
      return view !== undefined && recent(view) ? [{ view, depth, key: keyOf(id) }] : [];
    })
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.key.length, b.key.length); index += 1) {
        const order = a.key[index]!.localeCompare(b.key[index]!);
        if (order !== 0) return order;
      }
      return a.key.length - b.key.length;
    })
    .map(({ view, depth }) => ({ view, depth }));
}

/** The card's PR to show: the open (or not-yet-polled) one when there are several, else the newest linked. */
export function prOf(card: BoardTask): SubtreeRow['pr'] {
  const prs: readonly PrLink[] = card.links.prs;
  const live = prs.filter(pr => pr.state === 'open' || pr.state === 'unknown');
  const pick = live.at(-1) ?? prs.at(-1);
  return pick === undefined
    ? undefined
    : { number: pick.number, url: pick.url, state: pick.state, draft: pick.draft, checks: pick.checks };
}

/** The newest note on the card, as a candidate last line. */
function lastNote(card: BoardTask): { readonly at: string; readonly text: string } | undefined {
  for (let index = card.history.length - 1; index >= 0; index -= 1) {
    const event = card.history[index]!;
    if (event.type === 'note') return { at: event.at, text: event.text };
  }
  return undefined;
}

/** What a row last said, before it is redacted or cut. */
export interface LastCandidate {
  readonly at: string;
  readonly source: 'note' | 'message';
  readonly text: string;
}

/** The newer of the card's last note and the last message to the lead, in full; a tie goes to the note. */
export function newestLine(card: BoardTask | undefined, message: SentMessage | undefined): LastCandidate | undefined {
  const note = card === undefined ? undefined : lastNote(card);
  const candidates = [
    ...(note === undefined ? [] : [{ ...note, source: 'note' as const }]),
    ...(message === undefined ? [] : [{ at: message.at, text: message.text, source: 'message' as const }]),
  ];
  return candidates.reduce<LastCandidate | undefined>(
    (best, next) => (best === undefined || Date.parse(next.at) > Date.parse(best.at) ? next : best),
    undefined,
  );
}

/** A candidate as the row's last line: ALREADY-REDACTED `text` cut to one line; nothing when it is blank. */
export function excerptOf(candidate: LastCandidate, redacted: string): SubtreeRow['last'] {
  const text = oneLine(redacted);
  return text === '' ? undefined : { at: candidate.at, source: candidate.source, text };
}

/** One member's row, from the card it works on (when the board holds it) and its already-redacted last line. */
export function rowOf(
  member: SubtreeMember,
  card: BoardTask | undefined,
  laneName: string | undefined,
  last: SubtreeRow['last'],
): SubtreeRow {
  const { view, depth } = member;
  const focus = view.config.focusTask;
  const parent = parentOf(view);
  const state = subtreeStateOf(view);
  const endedAt = state === 'ended' ? endedAtOf(view) : undefined;
  const pr = card === undefined ? undefined : prOf(card);
  return {
    id: view.config.id,
    callsign: callsignOf(view),
    ...(parent === undefined ? {} : { parent }),
    depth,
    model: displayModel(view.config, view.state),
    state,
    status: view.state.status,
    ...(focus === undefined
      ? {}
      : { card: { ref: formatTaskRef(focus), ...(laneName === undefined ? {} : { lane: laneName }) } }),
    ...(pr === undefined ? {} : { pr }),
    ...(last === undefined ? {} : { last }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

/**
 * The members that get an excerpt: live ones in tree order up to `excerptRows`, then recently ended ones up to
 * `endedRows` and whatever room is left. Returns their positions in `members`.
 */
export function excerptEligible(members: readonly SubtreeMember[], limits: SubtreeLimits): ReadonlySet<number> {
  const positions = members.map((_, index) => index);
  const live = positions.filter(index => !isEnded(members[index]!.view));
  const ended = positions.filter(index => isEnded(members[index]!.view));
  const liveChosen = live.slice(0, limits.excerptRows);
  const endedChosen = ended.slice(0, Math.min(limits.endedRows, Math.max(0, limits.excerptRows - liveChosen.length)));
  return new Set([...liveChosen, ...endedChosen]);
}

export class SubtreeService {
  constructor(
    private readonly ports: SubtreePorts,
    private readonly limits: SubtreeLimits = SUBTREE_LIMITS,
  ) {}

  /**
   * The table for `rootId` (a session id), or `undefined` when no such session is in the registry. A row's
   * message is the newest one its ferret sent to `callerId` — the asking ferret, or `rootId` when none asks.
   */
  async view(rootId: string, callerId: string = rootId): Promise<SubtreeView | undefined> {
    const nowMs = this.ports.nowMs();
    const sessions = await this.ports.sessions();
    const root = sessionsById(sessions).get(rootId);
    if (root === undefined) return undefined;

    const members = subtreeMembers(sessions, rootId, nowMs);
    // One board read for every row, and only when some member works on a card.
    const board = members.some(member => member.view.config.focusTask !== undefined)
      ? await this.ports.board()
      : { cards: [] as readonly BoardTask[], laneSets: new Map() as LaneSets };
    const cards = new Map(board.cards.map(card => [card.id, card]));
    const cardOf = (member: SubtreeMember): BoardTask | undefined => {
      const focus = member.view.config.focusTask;
      return focus === undefined ? undefined : cards.get(focus.id);
    };

    const eligible = excerptEligible(members, this.limits);
    const messages = await this.messagesFor(members, eligible, callerId);
    const candidates = members.map((member, index) =>
      eligible.has(index) ? newestLine(cardOf(member), messages[index]) : undefined,
    );
    const lasts = await this.excerpts(candidates);

    const rows = members.map((member, index) => {
      const card = cardOf(member);
      const lane =
        card === undefined
          ? undefined
          : board.laneSets.get(card.projectId)?.lanes.find(candidate => candidate.id === card.laneId)?.name;
      return rowOf(member, card, lane, lasts[index]);
    });
    return {
      root: { id: root.config.id, callsign: callsignOf(root) },
      at: new Date(nowMs).toISOString(),
      endedWindowMs: SUBTREE_ENDED_WINDOW_MS,
      rows,
    };
  }

  /**
   * The newest message to `callerId` of each eligible member, read `concurrency` at a time in the order
   * `eligible` lists them (live rows before ended ones), each result at its member's position. Each read
   * reserves its bytes from the table's budget before it starts and hands back what it reports unused; a read
   * that fails keeps its whole reservation, since it may already have read them. One that finds the budget
   * spent reads nothing. A member that is not eligible, or whose read finds nothing, has no message.
   */
  private async messagesFor(
    members: readonly SubtreeMember[],
    eligible: ReadonlySet<number>,
    callerId: string,
  ): Promise<readonly (SentMessage | undefined)[]> {
    const { concurrency, outboxBytes, rowBytes } = this.limits;
    let remaining = outboxBytes;
    const order = [...eligible];
    const found = await mapBounded(order, concurrency, async index => {
      if (remaining <= 0) return undefined;
      const reserved = Math.min(rowBytes, remaining);
      remaining -= reserved;
      try {
        const { message, scanned } = await this.ports.lastMessage(members[index]!.view.config.id, callerId, reserved);
        remaining += Math.max(0, reserved - scanned);
        return message;
      } catch {
        return undefined;
      }
    });
    const messages: (SentMessage | undefined)[] = members.map(() => undefined);
    order.forEach((index, position) => {
      messages[index] = found[position];
    });
    return messages;
  }

  /** Every candidate redacted whole in ONE batch, then cut to a line; a redactor that fails withholds them all. */
  private async excerpts(candidates: readonly (LastCandidate | undefined)[]): Promise<SubtreeRow['last'][]> {
    const present = candidates.flatMap((candidate, index) => (candidate === undefined ? [] : [{ candidate, index }]));
    if (present.length === 0) return candidates.map(() => undefined);
    const redacted = await this.ports.redact(present.map(({ candidate }) => candidate.text)).catch(() => undefined);
    const safe = redacted?.length === present.length ? redacted : undefined;
    const lasts: SubtreeRow['last'][] = candidates.map(() => undefined);
    present.forEach(({ candidate, index }, position) => {
      lasts[index] =
        safe === undefined
          ? { at: candidate.at, source: candidate.source, text: EXCERPT_WITHHELD }
          : excerptOf(candidate, safe[position]!);
    });
    return lasts;
  }
}

/**
 * The newest message to `to` among the lines of an outbox's tail. A line that is not JSON (the tail may begin
 * mid-line), is a question, or went to someone else is skipped; so is a message with no text.
 */
export function newestMessageTo(tail: string, to: string): SentMessage | undefined {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { type, to: target, at, message } = entry as Record<string, unknown>;
    if (
      type === 'message' &&
      target === to &&
      typeof at === 'string' &&
      typeof message === 'string' &&
      message.trim() !== ''
    )
      return { at, text: message };
  }
  return undefined;
}
