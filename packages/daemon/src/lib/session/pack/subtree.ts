/**
 * THE SUBTREE TABLE A LEAD READS (`GET /v1/sessions/:sessionId/subtree`, docs/pack-mode.md).
 *
 * Everything here is read from what the daemon already holds — the sessions registry, the board's cards (which
 * carry the PR cache the watcher keeps; nothing here calls GitHub) and each ferret's outbox — in ONE pass, so a
 * lead with fifty descendants costs one request, one board read and one small file read per descendant.
 *
 * Lineage comes from the registry's `parent` links and nothing else: the request names only the root.
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

export interface SubtreePorts {
  sessions(): Promise<readonly SessionView[]>;
  /** Every card as stored, with each board's lanes: one store read. */
  board(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }>;
  /** The newest message `sessionId` sent to `to`, or `undefined` when it sent none. */
  lastMessage(sessionId: string, to: string): Promise<SentMessage | undefined>;
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
  const agenda = state.agenda ?? state.attention;
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

/** The newer of the card's last note and the last message to the lead; a tie goes to the note. */
export function lastLineOf(card: BoardTask | undefined, message: SentMessage | undefined): SubtreeRow['last'] {
  const note = card === undefined ? undefined : lastNote(card);
  const candidates = [
    ...(note === undefined ? [] : [{ ...note, source: 'note' as const }]),
    ...(message === undefined ? [] : [{ at: message.at, text: message.text, source: 'message' as const }]),
  ];
  const newest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, next) => (best === undefined || Date.parse(next.at) > Date.parse(best.at) ? next : best),
    undefined,
  );
  if (newest === undefined) return undefined;
  const text = oneLine(newest.text);
  return text === '' ? undefined : { at: newest.at, source: newest.source, text };
}

/** One member's row, from the card it works on (when the board holds it) and what it last said to the lead. */
export function rowOf(
  member: SubtreeMember,
  card: BoardTask | undefined,
  laneName: string | undefined,
  message: SentMessage | undefined,
): SubtreeRow {
  const { view, depth } = member;
  const focus = view.config.focusTask;
  const parent = parentOf(view);
  const state = subtreeStateOf(view);
  const endedAt = state === 'ended' ? endedAtOf(view) : undefined;
  const pr = card === undefined ? undefined : prOf(card);
  const last = lastLineOf(card, message);
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

export class SubtreeService {
  constructor(private readonly ports: SubtreePorts) {}

  /** The table for `rootId` (a session id), or `undefined` when no such session is in the registry. */
  async view(rootId: string): Promise<SubtreeView | undefined> {
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
    const messages = await Promise.all(
      members.map(async member => await this.ports.lastMessage(member.view.config.id, rootId)),
    );

    const rows = members.map((member, index) => {
      const focus = member.view.config.focusTask;
      const card = focus === undefined ? undefined : cards.get(focus.id);
      const lane =
        card === undefined
          ? undefined
          : board.laneSets.get(card.projectId)?.lanes.find(candidate => candidate.id === card.laneId)?.name;
      return rowOf(member, card, lane, messages[index]);
    });
    return {
      root: { id: root.config.id, callsign: callsignOf(root) },
      at: new Date(nowMs).toISOString(),
      endedWindowMs: SUBTREE_ENDED_WINDOW_MS,
      rows,
    };
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
