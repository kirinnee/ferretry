import type { BoardSkip, BoardTaskResponse, TaskRef } from '@ferretry/protocol';
import type { TranscriptEvent } from '../transcript/types.ts';
import { BoardError } from './errors.ts';

/**
 * THE BACKSTOP UNDER THE BOARD RULE (`board-design.md` §3.4, "Turn-end check").
 *
 * Every ferret is told to have a card before its first edit for a new ask (the fixed layer's `Board:`
 * section). A prose rule is not reliable, so when a turn ends the daemon reads it: if the turn did
 * MUTATING work — an edit tool, a git commit or push, a `fy new`, a `gh pr create` — while the session had
 * no focus card in an open lane, the ferret gets ONE queued message telling it to make one, or to record
 * why not with `fy task skip "<why>"`.
 *
 * - **Evidence, not inference.** Only the turn's own tool calls count. A read-only turn (questions,
 *   research, a plan) never triggers it, however long.
 * - **At most once an hour per session.** The send id carries the hour, so a turn end observed twice (a
 *   replayed journal, a restart) is one send, and the check remembers when it last spoke so two turns in
 *   the same hour are one nudge.
 * - **A recorded skip silences it** until the session takes a card, which clears the skip (the session owns
 *   both facts, `config.focusTask` and `config.boardSkip`).
 * - **A turn the nudge started is never checked**, so a reply to it cannot start a loop.
 * - **Silence when unsure.** A card or a session that cannot be read says nothing rather than guessing.
 *
 * Pure except {@link BoardTurnCheck}, which reads and sends through its ports.
 */

/** The first words of every nudge: how a later turn knows the nudge started it. */
export const BOARD_CHECK_MARK = '[board]';

/** How many transcript events back the turn is looked for. A longer turn is read in part. */
export const BOARD_CHECK_TAIL = 400;

/** The quiet period between two nudges to one session. */
export const BOARD_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** The tools that write a file: Claude's edit tools and Codex's patch. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The shell command a tool call ran, if it ran one: `command` or `cmd`, as a string or an argv. */
const commandOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const { command, cmd } = input as { readonly command?: unknown; readonly cmd?: unknown };
  const value = command ?? cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join(' ');
  return undefined;
};

/** The mutating commands, each with the words it is reported by. `binary` is the CLI's own name. */
const mutatingCommands = (binary: string): readonly (readonly [RegExp, string])[] => [
  [/\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/u, 'git commit'],
  [/\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b/u, 'git push'],
  [/\bgh\s+pr\s+create\b/u, 'gh pr create'],
  [new RegExp(`(?:^|[\\s/;&|(])${escapeRegExp(binary)}\\s+new\\b`, 'u'), `${binary} new`],
];

/** The tool calls of the session's last turn: everything after its last user-channel message. */
const lastTurn = (
  events: readonly TranscriptEvent[],
): { readonly opener: string; readonly turn: TranscriptEvent[] } => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'message' && event.role === 'user' && event.inputSource !== 'harness') {
      return { opener: event.text, turn: events.slice(index + 1) };
    }
  }
  return { opener: '', turn: [...events] };
};

/**
 * What mutating work the last turn did, each kind named once in the order first seen — empty for a
 * read-only turn, and for a turn the nudge itself started.
 */
export function mutatingWork(events: readonly TranscriptEvent[], binary: string): readonly string[] {
  const { opener, turn } = lastTurn(events);
  if (opener.trimStart().startsWith(BOARD_CHECK_MARK)) return [];
  const commands = mutatingCommands(binary);
  const seen: string[] = [];
  const note = (label: string) => {
    if (!seen.includes(label)) seen.push(label);
  };
  for (const event of turn) {
    if (event.kind !== 'tool-call') continue;
    if (EDIT_TOOLS.has(event.call.name)) note(event.call.name);
    const command = commandOf(event.call.input);
    if (command === undefined) continue;
    for (const [pattern, label] of commands) if (pattern.test(command)) note(label);
  }
  return seen;
}

/** The words of the nudge. Short on purpose: it starts a turn. */
export const boardCheckMessage = (binary: string): string =>
  `${BOARD_CHECK_MARK} You changed code this turn without a card. Create one (${binary} task create …) or record why not: ${binary} task skip "<why>"`;

/** The send id of the one nudge a session may get in an hour. */
export const boardCheckSendId = (sessionId: string, now: number): string =>
  `board-check-${sessionId}-${Math.floor(now / BOARD_CHECK_INTERVAL_MS)}`;

/** Whether a card is still being worked: in a lane that is not `closed`, and not dropped. */
export const isOpenCard = (response: BoardTaskResponse): boolean => {
  if (response.task.dropped !== null) return false;
  const lane = response.laneSet?.lanes.find(candidate => candidate.id === response.task.laneId);
  return lane !== undefined && lane.category !== 'closed';
};

/** What the check reads and how it sends. */
export interface BoardTurnCheckPorts {
  /** Whether the session has a transcript to read (an agent runtime this daemon can read). */
  readonly readable: (sessionId: string) => Promise<boolean>;
  /** The newest transcript events, oldest first. */
  readonly tail: (sessionId: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** The session's focus card and standing skip (`config.focusTask`, `config.boardSkip`). */
  readonly focus: {
    focusOf(sessionId: string): Promise<TaskRef | null>;
    skipOf(sessionId: string): Promise<BoardSkip | null>;
  };
  /** One card with its board's lanes; a card that is gone is refused `not-found`. */
  readonly card: (ref: TaskRef) => Promise<BoardTaskResponse>;
  /** The ordinary send; the same id twice is one message. */
  readonly send: (sessionId: string, sendId: string, message: string) => Promise<void>;
  /** Journals that a nudge went out, with the work it saw. */
  readonly record: (sessionId: string, seen: readonly string[]) => Promise<void>;
  readonly now: () => number;
}

/**
 * Runs the check at a turn end. Every failure is swallowed by the caller: a check that cannot read the
 * transcript, the session or the card says nothing.
 */
export class BoardTurnCheck {
  private readonly lastNudged = new Map<string, number>();

  constructor(
    private readonly ports: BoardTurnCheckPorts,
    private readonly binary: string,
  ) {}

  /** Checks the session's last turn; whether a nudge was sent. */
  async check(sessionId: string): Promise<boolean> {
    const now = this.ports.now();
    const last = this.lastNudged.get(sessionId);
    if (last !== undefined && now - last < BOARD_CHECK_INTERVAL_MS) return false;
    if (!(await this.ports.readable(sessionId))) return false;
    const seen = mutatingWork(await this.ports.tail(sessionId, BOARD_CHECK_TAIL), this.binary);
    if (seen.length === 0) return false;
    if ((await this.ports.focus.skipOf(sessionId)) !== null) return false;
    if (await this.hasOpenCard(sessionId)) return false;
    await this.ports.send(sessionId, boardCheckSendId(sessionId, now), boardCheckMessage(this.binary));
    this.lastNudged.set(sessionId, now);
    await this.ports.record(sessionId, seen);
    return true;
  }

  private async hasOpenCard(sessionId: string): Promise<boolean> {
    const focus = await this.ports.focus.focusOf(sessionId);
    if (focus === null) return false;
    try {
      return isOpenCard(await this.ports.card(focus));
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not-found') return false;
      throw error;
    }
  }
}
