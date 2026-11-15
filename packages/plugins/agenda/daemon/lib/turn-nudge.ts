import { ownerAsks } from '@ferretry/core-asks/contract';
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
 * - **Once per turn, never a loop.** The send id is the turn's own, so a turn end observed twice is one send. A turn the
 *   nudge itself started is never checked: its opener carries {@link AGENDA_NUDGE_MARK}.
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
  return { opener, reply, raised: turn.filter(raisesAgendaItem).length };
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
 * left alone.
 */
export function attentionNudge(
  turn: FinishedTurn,
  subject: NudgeSubject,
  binary: string,
): { readonly asks: readonly string[]; readonly message: string } | undefined {
  if (subject.parent) return undefined;
  if (turn.opener.trimStart().startsWith(AGENDA_NUDGE_MARK)) return undefined;
  const asks = ownerAsks(turn.reply);
  if (asks.length === 0 || turn.raised >= asks.length) return undefined;
  return { asks, message: agendaNudgeMessage(asks, turn.raised, subject, binary) };
}

/** The send id of the one nudge a turn may get. */
export const agendaNudgeSendId = (ferret: string, turn: string): string => `attention-nudge-${ferret}-${turn}`;

/** What the check reads and how it sends. */
export interface AgendaNudgePorts {
  /** The machine's switch (`agenda.yaml` `agendaNudge`), read per turn so turning it off is immediate. */
  readonly enabled: () => boolean;
  /** The ferret, or `undefined` when it cannot be read. */
  readonly subject: (ferret: string) => Promise<NudgeSubject | undefined>;
  /** The newest transcript events, oldest first; empty when none can be proved to be the ferret's. */
  readonly tail: (ferret: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** The send; the same id twice is one message. */
  readonly send: (ferret: string, sendId: string, message: string) => Promise<void>;
}

/** Runs the check at a turn end. A check that cannot read the transcript says nothing rather than guessing. */
export class AgendaTurnNudge {
  constructor(
    private readonly ports: AgendaNudgePorts,
    private readonly binary: string,
  ) {}

  /** Checks the ferret's turn that just ended; whether a nudge was sent. */
  async check(ferret: string, turn: string): Promise<boolean> {
    if (!this.ports.enabled()) return false;
    const subject = await this.ports.subject(ferret);
    if (subject === undefined || subject.parent) return false;
    const finished = finishedTurn(await this.ports.tail(ferret, AGENDA_NUDGE_TAIL));
    if (finished === undefined) return false;
    const nudge = attentionNudge(finished, subject, this.binary);
    if (nudge === undefined) return false;
    await this.ports.send(ferret, agendaNudgeSendId(ferret, turn), nudge.message);
    return true;
  }
}
