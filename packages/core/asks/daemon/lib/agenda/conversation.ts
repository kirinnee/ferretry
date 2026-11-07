import type { AgendaFormField, AgendaItem, AgendaResponse, ResolvedAgendaItem } from '../protocol/agenda.ts';
import type { AgendaMessageItem } from '../protocol/agenda-message.ts';
import {
  agendaAnswerMessage,
  agendaDiscussMessage,
  agendaDismissedMessage,
  agendaDoneMessage,
  agendaNeedsInfoMessage,
} from '../protocol/agenda-message.ts';
import { agendaCardKind, agendaTitle } from '../protocol/agenda-card.ts';
import { formWords } from '../protocol/agenda-form.ts';

/**
 * HOW AN AGENDA ITEM AND ITS FERRET'S CONVERSATION MEET (docs/agenda.md).
 *
 * An item is raised by a ferret and answered by the owner on the board; the answer reaches the ferret as an
 * ordinary message that names the item it answers — `[answer to !A3 «ask»] <answer>` — so the ferret never
 * has to poll its board. The owner may also TALK about an item in the conversation by referencing it (`!A3`,
 * the reference grammar's item form, docs/reference-standard.md): the message reaches the ferret as
 * `[re !A3 «title»] <text>`, resolves NOTHING, and makes the item the ferret's turn. A plain message that
 * references nothing is delivered exactly as typed: the ferret learns of its items when something happens to
 * one, and reads its board on demand (`agenda ls`).
 *
 * The WORDS of every such message are the protocol's (`agenda-message.ts`), which the app reads back to draw
 * them as cards; this module decides which message an event becomes.
 *
 * Pure: every decision here is a function of the board and the words; the composition root does the
 * reading, the sending and the resolving.
 */

/** An item as a heading names it: by its ask, the words the ferret raised it with. */
const byAsk = (item: Pick<AgendaItem, 'id' | 'subject'>): AgendaMessageItem => ({
  id: item.id,
  quote: item.subject,
});

/** An item as a heading names it: by its title, the card the owner is looking at. */
const byTitle = (item: AgendaItem): AgendaMessageItem => ({ id: item.id, quote: agendaTitle(item) });

/** The owner's answer in words: the choice they made, or what they wrote. */
function responseWords(response: AgendaResponse, fields: readonly AgendaFormField[] = []): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'Approved.' : 'Rejected.';
    case 'multiple-choice':
      return response.choice;
    case 'answer-review':
      return response.verdict === 'good' ? 'Your answer is good.' : `Please clarify: ${response.clarification}`;
    case 'open-question':
      return response.answer;
    case 'form':
      return `\n${formWords(fields, response.answers)}`;
    case 'other':
      return `Other answer (none of the options): ${response.answer}`;
  }
}

/**
 * Whether the owner's closing of an item is only "Got it": an `info` item marked done with no words. Nothing
 * was decided and nothing was said, so telling the ferret would pay for a turn to read an acknowledgement; the
 * item is simply resolved on its board, which the ferret reads next time it lists it. Anything the owner
 * wrote, a dismissal, or any other kind of item is still told.
 */
export function isQuietAcknowledgement(item: ResolvedAgendaItem): boolean {
  return (
    agendaCardKind(item) === 'info' &&
    item.disposition === 'done' &&
    item.response === undefined &&
    (item.resolutionNote?.trim() ?? '') === ''
  );
}

/**
 * The message a ferret receives when the owner closed one of ITS items on the board.
 *
 * EVERY CLOSING IS TOLD, the bare ones included (but for a bare "Got it" on an info item, `isQuietAcknowledgement`). A ferret that asked and is told nothing waits on an
 * item the owner has already settled: the board resolved, the panel cleared, and the ferret's own chat
 * never said so (the live defect this replaced kept a bare done or dismiss silent, to spare a finished
 * ferret one turn). An answer carries the owner's words; a done or a dismiss says which it was, with
 * the owner's note when there is one. An answer the owner worded themselves (`Always allow — <reply>`, a
 * "Skip") reaches the ferret as the note under the answer's own effect, so what was decided and what was
 * said are both read.
 */
export function boardReplyMessage(item: ResolvedAgendaItem): string {
  const note = item.resolutionNote?.trim() ?? '';
  if (item.response !== undefined)
    return agendaAnswerMessage(byAsk(item), responseWords(item.response, item.fields), note);
  if (item.disposition === 'dismissed') return agendaDismissedMessage(byAsk(item), note);
  return note === '' ? agendaDoneMessage(byAsk(item)) : agendaAnswerMessage(byAsk(item), 'Done', note);
}

/**
 * The message a ferret receives when the owner ANSWERED one of its items and the item rests, waiting on the ferret
 * (docs/agenda.md § States): the same words as an answer that closed it, so the ferret reads every answer one way.
 * `undefined` when the item carries no answer.
 */
export function ownerAnswerMessage(item: AgendaItem): string | undefined {
  const answer = item.ownerAnswer;
  if (answer === undefined) return undefined;
  return agendaAnswerMessage(byAsk(item), responseWords(answer.response, item.fields), answer.note?.trim() ?? '');
}

/**
 * The message a ferret receives when the owner asks it for more information on one of ITS items. The item
 * stays open: the ferret answers by expanding it (`agenda edit`), not by closing it.
 */
export function needsInfoMessage(item: AgendaItem): string {
  const note = item.history?.findLast(entry => entry.kind === 'needs-info')?.note?.trim() ?? '';
  return agendaNeedsInfoMessage(byAsk(item), note);
}

/**
 * The message a ferret receives when the owner, looking at a SURFACED item, wants to talk it through before answering —
 * they do not follow it, or its premise is wrong. The item stays open: the ferret answers in chat, then
 * updates the item (`agenda edit`) or closes it when the premise was wrong (`agenda done`).
 */
export function discussMessage(item: AgendaItem, binary: string): string {
  const note = item.history?.findLast(entry => entry.kind === 'discuss')?.note?.trim() ?? '';
  return agendaDiscussMessage(byTitle(item), note, binary);
}

/** What a person's chat message becomes once the open board is taken into account. */
