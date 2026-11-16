import { createHash } from 'node:crypto';
import { ASK_REFERENCE_SIGIL, ownerAsks, parseAgendaMessage } from '@ferretry/core-asks/contract';
import type { TranscriptEvent } from '@ferretry/plugin-conversation/contract';

/**
 * THE SAFETY NET UNDER THE AGENDA RULE (docs/agenda.md, "The turn-end check").
 *
 * Every ferret is told that each thing the owner must do is its own Agenda item, never prose alone. A prose rule is
 * not reliable: a ferret ends a reply with "Next steps: You: …" and raises nothing, and the owner, who reads the board,
 * never learns there was something to do. So when a turn ends the daemon reads the ferret's final reply. If it asks the
 * owner to act (`ownerAsks`, a structural detector) and the turn raised fewer items than it asked for, the ferret gets
 * ONE short message saying which asks to raise, or to say why not.
 *
 * - **Never a loop.** A ferret is nudged at most ONCE until a message that is not Agenda's reaches it ({@link nudgeSpent},
 *   kept in Agenda's own state so a restart does not reset it). The send id is keyed on the reply, so a turn end observed
 *   twice is one send. A turn the nudge itself started is also never checked: its opener carries
 *   {@link AGENDA_NUDGE_MARK} or says the words of Agenda's newest send ({@link startedByNudge}).
 * - **Only replies the owner reads.** A helper's reply goes to the ferret that started it, which raises what the owner
 *   must do, so a helper is never checked (Pack mode).
 * - **Evidence over inference.** The turn's own tool calls are what count as "raised": a command running `agenda add|edit`
 *   or `notify`, an `ask_owner` tool or the harness's question tool. A board change somebody else made in the same
 *   seconds is not evidence.
 *
 * Pure except {@link AgendaTurnNudge}, which reads and sends through its ports.
 */

/** The first words of every nudge: how a later turn knows the nudge started it. */
export const AGENDA_NUDGE_MARK = '[attention check]';

/** How every nudge's send id begins; with the send's author, how a send is known as Agenda's. */
export const AGENDA_NUDGE_ID_PREFIX = 'attention-nudge-';

/** How many transcript events back the final turn is looked for. A turn longer than this is read in part. */
export const AGENDA_NUDGE_TAIL = 400;

/** The ferret's last turn, as the check needs it. */
export interface FinishedTurn {
  /** The message that started it; empty when the tail holds none. */
  readonly opener: string;
  /** The final assistant reply: the text written after the turn's last tool call. */
  readonly reply: string;
  /** How many Agenda items the turn's own tool calls raised or edited. */
  readonly raised: number;
  /** The items the opener was an owner reply about (`[re !A5 «title»] …`), without the `!`. */
  readonly discussed: readonly string[];
  /** Of those, the ones the turn's own tool calls answered, rested, edited, closed or surfaced. */
  readonly handled: readonly string[];
}

/**
 * A tool call that raises, edits, answers or notifies: a shell command running `agenda add` / `edit` / `answer` /
 * `notify`, a Ferretry `*_ask_owner` tool, or the harness's own question tool, which the daemon raises as a card itself.
 */
const RAISING_COMMAND = /\b(?:(?:attention|agenda)["',\s]+(?:add|edit|answer)|notify)\b/u;
const RAISING_TOOL = /(?:^|_)ask_owner$|^AskUserQuestion$/u;

export const raisesAgendaItem = (event: TranscriptEvent): boolean => {
  if (event.kind !== 'tool-call') return false;
  if (RAISING_TOOL.test(event.call.name)) return true;
  if (event.call.name.endsWith('_open') && JSON.stringify(event.call.input).includes('"askOwner"')) return true;
  return RAISING_COMMAND.test(JSON.stringify(event.call.input));
};

/** A command that answers, rests, edits, closes or surfaces the item: `agenda answer|rest|edit|done|dismiss|surface` naming it. */
const handles = (event: TranscriptEvent, id: string): boolean =>
  event.kind === 'tool-call' &&
  new RegExp(`\\b(?:attention|agenda)\\W+(?:answer|rest|edit|done|dismiss|surface)\\b.{0,400}?\\b!?${id}\\b`, 'u').test(
    JSON.stringify(event.call.input),
  );

/** The items an owner chat message was about: the opener the daemon words for one, `[re !A5 «title», !A7 «title»] …`. */
const discussedIn = (opener: string): string[] => {
  const [first] = parseAgendaMessage(opener)?.parts ?? [];
  return first?.kind === 're' ? [...new Set(first.items.map(item => item.id))] : [];
};

/**
 * The last turn in a transcript tail, or `undefined` when there is none to check: no assistant reply after the turn's
 * last tool call (the turn ended on a tool, or was interrupted before it spoke). A turn starts at the last user-channel
 * message; the harness's own records (`inputSource: 'harness'`) and tool results are not openers.
 */
export function finishedTurn(events: readonly TranscriptEvent[]): FinishedTurn | undefined {
  const start = events.findLastIndex(
    event => event.kind === 'message' && event.role === 'user' && event.inputSource !== 'harness',
  );
  const opening = events[start];
  const opener = opening?.kind === 'message' ? opening.text : '';
  const turn = events.slice(start + 1);
  const lastTool = turn.findLastIndex(event => event.kind === 'tool-call' || event.kind === 'tool-result');
  const reply = turn
    .slice(lastTool + 1)
    .flatMap(event =>
      event.kind === 'message' && event.role === 'assistant' && event.inputSource !== 'harness' ? [event.text] : [],
    )
    .join('\n')
    .trim();
  if (reply === '') return undefined;
  const discussed = discussedIn(opener);
  return {
    opener,
    reply,
    raised: turn.filter(raisesAgendaItem).length,
    discussed,
    handled: discussed.filter(id => turn.some(event => handles(event, id))),
  };
}

/** What the session is, as far as the check is concerned. */
export interface NudgeSubject {
  /** A helper reports to the ferret that started it, never to the owner. */
  readonly parent: boolean;
  /** An interactive ferret may also ask with its question tool; an auto one has none. */
  readonly mode: 'interactive' | 'auto';
  /** Agenda mode is on for the session: the fix is an agenda item, else a notice. */
  readonly agenda: boolean;
}

/** The words of one nudge. Short on purpose: it starts a turn. */
export function agendaNudgeMessage(
  asks: readonly string[],
  raised: number,
  subject: Pick<NudgeSubject, 'mode' | 'agenda'>,
  binary: string,
): string {
  const listed = asks.map(ask => `- ${ask}`).join('\n');
  const already = raised > 0 ? ` You raised ${raised} this turn; raise the rest.` : '';
  if (!subject.agenda) {
    return `${AGENDA_NUDGE_MARK} Your last reply asked the owner to:\n${listed}\nThe owner reads notifications, not every reply.${already} Send each as its own notice — \`${binary} notify "<summary>"\` — or, if it needs no owner, say why not in one line.`;
  }
  const add = `\`${binary} agenda add --title "<what>" "<the ask>" --premise … --context … --step …\` (a to-do) or with \`--kind choice --option\` (a choice)`;
  const how = subject.mode === 'interactive' ? `${add}, or your question tool` : add;
  return `${AGENDA_NUDGE_MARK} Your last reply asked the owner to:\n${listed}\nThe owner reads the agenda, not every reply.${already} Raise each as its own agenda item — ${how} — or, if an open item already covers it or it needs no owner, say why not in one line.`;
}

/**
 * The nudge for a finished turn, or `undefined` when there is nothing to say. Pure: a helper, a turn the nudge itself
 * started, a reply that asks nothing of the owner, and a turn that raised as many items as the reply asked for are all
 * left alone. One message at most: the discussed-item line first, then, only when the reply also asked the owner to
 * act, the raise line.
 */
export function attentionNudge(
  turn: FinishedTurn,
  subject: NudgeSubject,
  binary: string,
  lastNudge?: string,
): { readonly asks: readonly string[]; readonly message: string } | undefined {
  if (subject.parent) return undefined;
  if (turn.opener.trimStart().startsWith(AGENDA_NUDGE_MARK)) return undefined;
  if (startedByNudge(turn.opener, lastNudge)) return undefined;
  const left = turn.discussed.filter(id => !turn.handled.includes(id));
  const asks = ownerAsks(turn.reply);
  const toRaise = asks.length > 0 && turn.raised < asks.length;
  const raise = toRaise ? agendaNudgeMessage(asks, turn.raised, subject, binary) : undefined;
  if (left.length === 0) return raise === undefined ? undefined : { asks, message: raise };
  const discussion = discussionNudgeMessage(left, binary);
  return {
    asks: [...left.map(id => `discussed ${ASK_REFERENCE_SIGIL}${id}`), ...(toRaise ? asks : [])],
    message: raise === undefined ? discussion : `${discussion}\n${raise.slice(AGENDA_NUDGE_MARK.length).trim()}`,
  };
}

/**
 * THE DISCUSSED-ITEM LINE (as v4): the owner replied about items (`[re !A5 …]`) and the ferret answered in chat only. A
 * replied item RESTS, off the owner's list and waiting on the ferret: the words say to answer on it (back to the owner,
 * in its old place), or to close it when nothing more is expected.
 */
export function discussionNudgeMessage(ids: readonly string[], binary: string): string {
  const named = ids.map(id => `${ASK_REFERENCE_SIGIL}${id}`).join(', ');
  const first = ids[0] as string;
  const off = ids.length === 1 ? 'it rests, waiting on you' : 'they rest, waiting on you';
  return `${AGENDA_NUDGE_MARK} Owner replied about ${named}; ${off}. Answer on it: \`${binary} agenda answer ${first} "<text>"\` (back on their list), or \`${binary} agenda done ${first}\` when nothing more is expected.`;
}

/** How long after a turn ends the transcript is read: the pane shows the end before the last words reach the file (as v4). */
export const AGENDA_NUDGE_SETTLE_MS = 2000;

/** Whitespace folded away, so a message compares equal however a harness wraps or re-flows it. */
const squeezed = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * Whether a turn's opener is a nudge's own delivery: the opener says what the newest Agenda send said, bare or wrapped
 * (a Claude paste is recorded inside `<pasted_content …>`). A nudge delivered by pointer (a turn file, a queued-message
 * pointer) carries none of its words; the one-nudge cap ({@link nudgeSpent}) is what holds for those.
 */
export function startedByNudge(opener: string, lastNudge: string | undefined): boolean {
  const said = squeezed(lastNudge ?? '');
  return said !== '' && squeezed(opener).includes(said);
}

/** The one nudge a ferret holds: its send and when it was made, as Agenda's own state keeps them. */
export interface NudgeMark {
  readonly sendId: string;
  readonly at: string;
}

/** One send to the ferret, as the check reads the ledger. A withdrawn send (nothing was typed) is not listed. */
export interface NudgeSend {
  readonly sendId: string;
  readonly acceptedAt: string;
  readonly message: string;
  /** Agenda's own words: the send's author is Ferretry's Agenda, or its id is a nudge's. */
  readonly agenda: boolean;
}

/** Where the cap is kept: Agenda's own small state, so a restart does not reset it. */
export interface NudgeStore {
  mark(ferret: string): Promise<NudgeMark | undefined>;
  /** Records the nudge when the ferret still holds `replacing` (or none); whether this call took it. */
  reserve(ferret: string, taken: NudgeMark, replacing: string | undefined): Promise<boolean>;
  /** Takes back a nudge whose send failed, so nothing was nudged. */
  release(ferret: string, sendId: string): Promise<void>;
}

/**
 * THE CAP: at most one nudge per ferret until a message that is not Agenda's (the owner, a peer, a notice) reaches it.
 * A turn a nudge started often ends on a "Next steps: You: …" line again; without the cap that is a nudge every turn.
 */
export function nudgeSpent(mark: NudgeMark | undefined, sends: readonly NudgeSend[]): boolean {
  if (mark === undefined) return false;
  const since = Date.parse(mark.at);
  return !sends.some(send => !send.agenda && Date.parse(send.acceptedAt) > since);
}

/** The words of the newest Agenda send, and how many Agenda sends the ferret has had. */
export function agendaSends(sends: readonly NudgeSend[]): {
  readonly newest: string | undefined;
  readonly count: number;
} {
  const own = sends.filter(send => send.agenda).sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
  return { newest: own.at(-1)?.message, count: own.length };
}

/** The send id of the one nudge a reply may get: keyed on the reply (its digest), so a state flicker never nudges it twice. */
export const agendaNudgeSendId = (ferret: string, reply: string, count: number): string =>
  `${AGENDA_NUDGE_ID_PREFIX}${ferret}-${createHash('sha256').update(reply).digest('hex').slice(0, 16)}-${count}`;

/**
 * A send the port did not accept, with the code Conversation answered. The code is what tells "nothing was typed" from
 * "typed, landing not proven": see {@link nothingTyped}.
 */
export class NudgeSendFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NudgeSendFailure';
  }
}

/** The answers that prove nothing reached the ferret's box: a refusal, a draft in the way, a launch in flight. */
const NOTHING_TYPED: ReadonlySet<string> = new Set([
  'send_refused',
  'not_found',
  'composer_occupied',
  'session_launching',
  'invalid',
]);

/**
 * Whether a failed send is KNOWN to have typed nothing, so the cap may be given back. Anything else (`send_unconfirmed`,
 * a `session_send_failed` whose record is kept, a code not listed, a throw that is not a {@link NudgeSendFailure}) may
 * have reached the prompt, and keeps the mark: an under-nudge is harmless, a nudge loop spends the owner's model.
 */
export const nothingTyped = (error: unknown): boolean =>
  error instanceof NudgeSendFailure && NOTHING_TYPED.has(error.code);

/** What the check reads and how it sends. */
export interface AgendaNudgePorts extends NudgeStore {
  /** The machine's switch (`agenda.yaml` `agendaNudge`), read per turn so turning it off is immediate. */
  readonly enabled: () => boolean;
  /** The ferret, or `undefined` when it cannot be read. */
  readonly subject: (ferret: string) => Promise<NudgeSubject | undefined>;
  /** The newest transcript events, oldest first; empty when none can be proved to be the ferret's. */
  readonly tail: (ferret: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** What has been sent to the ferret, from the send ledger. */
  readonly sends: (ferret: string) => Promise<readonly NudgeSend[]>;
  /** Lets this long pass. */
  readonly pause: (ms: number) => Promise<void>;
  /** Now, as an instant. */
  readonly now: () => string;
  /** The send; the same id twice is one message. Throws a {@link NudgeSendFailure} for an answer that is not an acceptance. */
  readonly send: (ferret: string, sendId: string, message: string) => Promise<void>;
}

/** Runs the check at a turn end. A send that may have been typed keeps its mark.  A check that cannot read the transcript says nothing rather than guessing. */
export class AgendaTurnNudge {
  constructor(
    private readonly ports: AgendaNudgePorts,
    private readonly binary: string,
  ) {}

  /** Checks the ferret's turn that just ended; whether a nudge was sent. */
  async check(ferret: string): Promise<boolean> {
    if (!this.ports.enabled()) return false;
    const subject = await this.ports.subject(ferret);
    if (subject === undefined || subject.parent) return false;
    await this.ports.pause(AGENDA_NUDGE_SETTLE_MS);
    const mark = await this.ports.mark(ferret);
    const sends = await this.ports.sends(ferret);
    if (nudgeSpent(mark, sends)) return false;
    const finished = finishedTurn(await this.ports.tail(ferret, AGENDA_NUDGE_TAIL));
    if (finished === undefined) return false;
    const own = agendaSends(sends);
    const nudge = attentionNudge(finished, subject, this.binary, own.newest);
    if (nudge === undefined) return false;
    const sendId = agendaNudgeSendId(ferret, finished.reply, own.count);
    if (!(await this.ports.reserve(ferret, { sendId, at: this.ports.now() }, mark?.sendId))) return false;
    try {
      await this.ports.send(ferret, sendId, nudge.message);
    } catch (error) {
      if (nothingTyped(error)) await this.ports.release(ferret, sendId).catch(() => undefined);
      throw error;
    }
    return true;
  }
}
