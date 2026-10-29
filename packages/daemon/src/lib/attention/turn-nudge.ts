import { createHash } from 'node:crypto';
import type { TranscriptEvent } from '../transcript/types.ts';
import { ownerAsks } from './owner-asks.ts';

/**
 * THE SAFETY NET UNDER THE ATTENTION RULE (docs/attention.md, "The turn-end check").
 *
 * Every ferret is told that each thing the owner must do is its own Attention item, never prose alone.
 * A prose rule is not reliable: a ferret ends a reply with "Next steps: You: …" and raises nothing, and
 * the owner — who reads the board, not every reply — never learns there was something to do. So when a
 * turn ends the daemon reads the ferret's final reply. If it asks the owner to act (`ownerAsks`, a
 * structural detector) and the turn raised fewer items than it asked for, the ferret gets ONE short
 * message saying which asks to raise — or to say why not.
 *
 * - **Once per reply, never a loop.** The send id is derived from the reply, so a turn end observed twice
 *   (a replayed journal, a restart) is one send. A turn the nudge itself started is never checked: its
 *   first owner-channel message carries {@link ATTENTION_NUDGE_MARK}, so a reply to the nudge that still
 *   lists asks ends the exchange.
 * - **Only replies the owner reads.** A sub-ferret's reply goes to the ferret that started it, which
 *   raises what the owner must do, so a session with a parent is never checked (Pack mode).
 * - **Evidence over inference.** The turn's own tool calls are what count as "raised": a command running
 *   `attention add|edit`, an `ask_owner` tool or the harness's question tool. A board change made by
 *   somebody else in the same seconds is not evidence that the ferret raised anything.
 *
 * The same check guards the living summary (docs/attention.md, "A card is a living summary"): when the
 * turn answered an owner reply about an ask IN DISCUSSION (`[reply about !A5 «title»] …`) and the ferret
 * neither edited, closed nor surfaced that ask during the turn, the one nudge says so
 * (`discussionNudgeMessage`) — once per owner reply, and a turn the nudge started never gets another.
 *
 * Pure except {@link AttentionTurnNudge}, which reads and sends through its ports.
 */

/** The first words of every nudge: how a later turn knows the nudge started it. */
export const ATTENTION_NUDGE_MARK = '[attention check]';

/** How many transcript events back the final turn is looked for. A turn longer than this is read in part. */
export const ATTENTION_NUDGE_TAIL = 400;

/** The ferret's last turn, as the check needs it. */
export interface FinishedTurn {
  /** The message that started it, as the ferret received it; empty when the tail holds none. */
  readonly opener: string;
  /** The final assistant reply: the text written after the turn's last tool call. */
  readonly reply: string;
  /** A stable name for the reply (its record or message id, else a digest of its words). */
  readonly replyKey: string;
  /** How many Attention items the turn's own tool calls raised or edited. */
  readonly raised: number;
  /** The items the opener was an owner reply about, in discussion (`[reply about !A5 …]`), without the `!`. */
  readonly discussed: readonly string[];
  /** Of those, the ones the turn's own tool calls edited, closed or surfaced. */
  readonly handled: readonly string[];
}

/**
 * A tool call that raises or edits an Attention item: a shell command running `attention add` / `edit`
 * (the CLI, under whatever binary name), a Ferretry `*_ask_owner` tool, or the harness's own question tool,
 * which the daemon raises as an item itself (`harness-prompt.ts`).
 */
const RAISING_COMMAND = /\battention["',\s]+(?:add|edit)\b/u;
const RAISING_TOOL = /(?:^|_)ask_owner$|^AskUserQuestion$/u;

const raises = (event: TranscriptEvent): boolean => {
  if (event.kind !== 'tool-call') return false;
  if (RAISING_TOOL.test(event.call.name)) return true;
  if (event.call.name.endsWith('_open') && JSON.stringify(event.call.input).includes('"askOwner"')) return true;
  return RAISING_COMMAND.test(JSON.stringify(event.call.input));
};

/** The owner's reply about an ask in discussion, as the daemon words it for the ferret (conversation.ts). */
const REPLY_ABOUT = /\[reply about !(A[1-9][0-9]*)\b/gu;

/** A command that edits, closes or surfaces the item: `attention edit|done|dismiss|surface` naming it. */
const handles = (event: TranscriptEvent, id: string): boolean =>
  event.kind === 'tool-call' &&
  new RegExp(`\\battention\\W+(?:edit|done|dismiss|surface)\\b.{0,400}?\\b!?${id}\\b`, 'u').test(
    JSON.stringify(event.call.input),
  );

const discussedIn = (opener: string): string[] => [
  ...new Set([...opener.matchAll(REPLY_ABOUT)].map(match => match[1] as string)),
];

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/**
 * The last turn in a transcript tail, or `undefined` when there is none to check: no assistant reply
 * after the turn's last tool call (the turn ended on a tool, or was interrupted before it spoke).
 *
 * A turn starts at the last user-channel message — any of them, because whatever the ferret was answering,
 * its reply is what the owner reads. The harness's own records (`inputSource: 'harness'`) and tool results
 * are not openers.
 */
export function finishedTurn(events: readonly TranscriptEvent[]): FinishedTurn | undefined {
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'message' && event.role === 'user' && event.inputSource !== 'harness') {
      start = index;
      break;
    }
  }
  const opener = start < 0 ? '' : (events[start] as { readonly text: string }).text;
  const turn = events.slice(start + 1);
  const discussed = discussedIn(opener);
  let lastTool = -1;
  turn.forEach((event, index) => {
    if (event.kind === 'tool-call' || event.kind === 'tool-result') lastTool = index;
  });
  const said = turn
    .slice(lastTool + 1)
    .filter(
      (event): event is Extract<TranscriptEvent, { kind: 'message' }> =>
        event.kind === 'message' && event.role === 'assistant' && event.inputSource !== 'harness',
    );
  const reply = said
    .map(event => event.text)
    .join('\n')
    .trim();
  if (reply === '') return undefined;
  const last = said[said.length - 1];
  const named = last?.messageId ?? last?.recordId ?? last?.itemId;
  return {
    opener,
    reply,
    replyKey: named === undefined ? digest(reply) : digest(named),
    raised: turn.filter(raises).length,
    discussed,
    handled: discussed.filter(id => turn.some(event => handles(event, id))),
  };
}

/** What the session is, as far as the check is concerned. */
export interface NudgeSubject {
  /** A sub-ferret reports to the ferret that started it, never to the owner. */
  readonly parent: boolean;
  /** An interactive ferret may also ask with its question tool; an auto one has none. */
  readonly mode: 'interactive' | 'auto';
}

/** The words of one nudge. Short on purpose: it starts a turn. */
export function attentionNudgeMessage(
  asks: readonly string[],
  raised: number,
  mode: NudgeSubject['mode'],
  binary: string,
): string {
  const listed = asks.map(ask => `- ${ask}`).join('\n');
  const already = raised > 0 ? ` You raised ${raised} this turn; raise the rest.` : '';
  const how =
    mode === 'interactive'
      ? `\`${binary} attention add --title "<what>" "<the ask>" --step …\` (a to-do) or with \`--kind choice --option\` (a choice), or your question tool`
      : `\`${binary} attention add --title "<what>" "<the ask>" --step …\` (a to-do) or with \`--kind choice --option\` (a choice)`;
  return `${ATTENTION_NUDGE_MARK} Your last reply asked the owner to:\n${listed}\nThe owner reads the Attention board, not every reply.${already} Raise each as its own Attention item — ${how} — or, if an open item already covers it or it needs no owner, say why not in one line.`;
}

/** The words of the nudge for asks the ferret discussed and left as they were. Short on purpose. */
export function discussionNudgeMessage(ids: readonly string[], binary: string): string {
  const named = ids.map(id => `!${id}`).join(', ');
  const first = ids[0] as string;
  return `${ATTENTION_NUDGE_MARK} You discussed ${named} — update its card (\`${binary} attention edit ${first}\`: decided so far, still open, fresh options), surface it (\`${binary} attention surface ${first}\`) or close it (\`${binary} attention done ${first}\`).`;
}

/**
 * The nudge for a finished turn, or `undefined` when there is nothing to say. Pure. One message at most:
 * the discussed-ask line first, then — only when the reply also asked the owner to act — the raise line.
 */
export function attentionNudge(
  turn: FinishedTurn,
  subject: NudgeSubject,
  binary: string,
): { readonly asks: readonly string[]; readonly message: string } | undefined {
  if (subject.parent) return undefined;
  if (turn.opener.trimStart().startsWith(ATTENTION_NUDGE_MARK)) return undefined;
  const left = turn.discussed.filter(id => !turn.handled.includes(id));
  const asks = ownerAsks(turn.reply);
  const toRaise = asks.length > 0 && turn.raised < asks.length;
  const raise = toRaise ? attentionNudgeMessage(asks, turn.raised, subject.mode, binary) : undefined;
  if (left.length === 0) return raise === undefined ? undefined : { asks, message: raise };
  const discussion = discussionNudgeMessage(left, binary);
  return {
    asks: [...left.map(id => `discussed !${id}`), ...(toRaise ? asks : [])],
    message: raise === undefined ? discussion : `${discussion}\n${raise.slice(ATTENTION_NUDGE_MARK.length).trim()}`,
  };
}

/** The send id of the one nudge a reply may get. */
export const attentionNudgeSendId = (sessionId: string, replyKey: string): string =>
  `attention-nudge-${sessionId}-${replyKey}`;

/** What the check reads and how it sends. */
export interface AttentionNudgePorts {
  /** The machine's switch (`machine.yaml` `attentionNudge`), read per turn so turning it off is immediate. */
  readonly enabled: () => Promise<boolean>;
  /** The session, or `undefined` when its documents cannot be read. */
  readonly subject: (sessionId: string) => Promise<NudgeSubject | undefined>;
  /** The newest transcript events, oldest first. */
  readonly tail: (sessionId: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** The ordinary send; the same id twice is one message. */
  readonly send: (sessionId: string, sendId: string, message: string) => Promise<void>;
  /** Journals that a nudge went out, with the asks it named. */
  readonly record: (sessionId: string, asks: readonly string[]) => Promise<void>;
}

/** Whether a journal event is the end of a turn: the ferret handed control back. */
export const isTurnEnd = (type: string, data: unknown): boolean =>
  type === 'turn.state' &&
  typeof data === 'object' &&
  data !== null &&
  (data as { readonly to?: unknown }).to === 'your-turn';

/**
 * Runs the check at a turn end. One session at a time is enough: a nudge is a message, and the send
 * slice already orders and dedupes them. Every failure is swallowed by the caller — a check that cannot
 * read the transcript says nothing rather than guessing.
 */
export class AttentionTurnNudge {
  constructor(
    private readonly ports: AttentionNudgePorts,
    private readonly binary: string,
  ) {}

  /** Checks the session's last turn; whether a nudge was sent. */
  async check(sessionId: string): Promise<boolean> {
    if (!(await this.ports.enabled())) return false;
    const subject = await this.ports.subject(sessionId);
    if (subject === undefined || subject.parent) return false;
    const turn = finishedTurn(await this.ports.tail(sessionId, ATTENTION_NUDGE_TAIL));
    if (turn === undefined) return false;
    const nudge = attentionNudge(turn, subject, this.binary);
    if (nudge === undefined) return false;
    await this.ports.send(sessionId, attentionNudgeSendId(sessionId, turn.replyKey), nudge.message);
    await this.ports.record(sessionId, nudge.asks);
    return true;
  }
}
