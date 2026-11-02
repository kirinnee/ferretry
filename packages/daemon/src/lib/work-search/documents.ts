/**
 * WHAT A PIECE OF WORK SAYS, as work search indexes it: a card or an agenda item turned into a few named
 * fields of plain text (docs/work-search.md § What is indexed).
 *
 * THE FIELDS ARE A WHITELIST. Each one is text the owner already reads on the card or the item; nothing
 * is indexed by walking an object, so a field added to either schema later is NOT searchable until it is
 * named here on purpose. An input request's card carries its label and never a value (values are never
 * stored at all), and every text passes through the secret redactor before it reaches the index — the
 * caller hands in the scrub, so a document cannot be built from unscrubbed text by accident.
 *
 * Plain notifications (`fy notify`) are not agenda items and are not indexed.
 */
import type {
  AgendaItem,
  BoardTask,
  LaneSet,
  ResolvedAgendaItem,
  WorkField,
  WorkHit,
  WorkKind,
  WorkState,
} from '@ferretry/protocol';
import type { AgendaLedger } from '../agenda/state-machine.ts';

/** One named piece of a document's text. */
interface WorkDocumentField {
  readonly field: WorkField;
  readonly text: string;
}

/** A hit without its match and score: who the document is, as every answer about it says. */
type WorkIdentity = WorkHit extends infer Hit ? (Hit extends WorkHit ? Omit<Hit, 'match' | 'score'> : never) : never;

/** One indexed piece of work. */
export interface WorkDocument {
  /** `task:F303`, or `agenda:<session>:A3` — an agenda id is only unique inside its session. */
  readonly key: string;
  readonly kind: WorkKind;
  readonly identity: WorkIdentity;
  readonly updatedAtMs: number;
  readonly fields: readonly WorkDocumentField[];
}

/** Masks known secret values in one text. The redactor's scrub, for the duration of one indexing batch. */
export type ScrubText = (text: string) => string;

export const taskKey = (id: string): string => `task:${id}`;
const agendaKey = (sessionId: string, id: string): string => `agenda:${sessionId}:${id}`;

/** Fields in a fixed order, empties dropped, every text scrubbed. */
const fieldsOf = (scrub: ScrubText, pairs: readonly (readonly [WorkField, string | null | undefined])[]) =>
  pairs.flatMap(([field, text]): WorkDocumentField[] => {
    const trimmed = text?.trim() ?? '';
    return trimmed.length === 0 ? [] : [{ field, text: scrub(trimmed) }];
  });

const joined = (texts: readonly (string | null | undefined)[]): string =>
  texts.filter((text): text is string => typeof text === 'string' && text.trim().length > 0).join('\n');

const instantMs = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * A card as a document. Old closed work is kept: the index decides what the window hides, so a query
 * can still ask for all of it. A card on a
 * board whose lanes cannot be read stands as open under its lane id: findable beats hidden.
 */
export const cardDocument = (card: BoardTask, laneSet: LaneSet | undefined, scrub: ScrubText): WorkDocument => {
  const lane = laneSet?.lanes.find(candidate => candidate.id === card.laneId);
  const state: WorkState = card.dropped !== null ? 'dropped' : lane?.category === 'closed' ? 'closed' : 'open';
  const updatedAtMs = instantMs(card.dropped?.at ?? card.history.at(-1)?.at ?? card.createdAt);
  const notes = card.history.flatMap(event => (event.type === 'note' ? [event.text] : []));
  return {
    key: taskKey(card.id),
    kind: 'task',
    updatedAtMs,
    identity: {
      kind: 'task',
      id: card.id,
      projectId: card.projectId,
      sessionId: card.owner ?? null,
      title: scrub(card.title),
      state,
      standing: state === 'dropped' ? 'Dropped' : (lane?.name ?? card.laneId),
      updatedAt: new Date(updatedAtMs).toISOString(),
    },
    fields: fieldsOf(scrub, [
      ['id', card.id],
      ['title', card.title],
      ['summary', card.summary],
      ['ask', joined([card.ask.text, ...card.clarifications.map(clarification => clarification.text)])],
      ['premise', card.premise],
      ['context', card.context],
      ['brief', card.brief],
      ['howToTest', card.howToTest],
      ['note', joined(notes)],
    ]),
  };
};

/** Where an open item stands, in the words the Inbox uses. */
const openStanding = (item: AgendaItem): string => {
  if (item.parked?.reason === 'snoozed') return 'snoozed';
  if (item.parked?.reason === 'replied') return 'replied';
  if (item.waitingOn === 'ferret') return item.waitingFor === 'discussion' ? 'in discussion' : 'needs info';
  return 'open';
};

const lastActivityMs = (item: AgendaItem): number =>
  Math.max(
    instantMs(item.waitingSince),
    instantMs(item.history?.at(-1)?.at ?? item.waitingSince),
    instantMs(item.revisions?.at(-1)?.at ?? item.waitingSince),
  );

/** What the owner answered, as words: a choice, an answer, a clarification. */
const responseText = (item: ResolvedAgendaItem): string | undefined => {
  const response = item.response;
  if (response === undefined) return undefined;
  if (response.kind === 'multiple-choice') return response.choice;
  if (response.kind === 'open-question' || response.kind === 'other') return response.answer;
  if (response.kind === 'answer-review' && response.verdict === 'clarify') return response.clarification;
  return undefined;
};

const itemDocument = (
  sessionId: string,
  item: AgendaItem | ResolvedAgendaItem,
  resolved: ResolvedAgendaItem | undefined,
  scrub: ScrubText,
): WorkDocument | undefined => {
  if (item.notice === true) return undefined;
  const state: WorkState = resolved === undefined ? 'open' : 'closed';
  const updatedAtMs = resolved === undefined ? lastActivityMs(item) : instantMs(resolved.resolvedAt);
  const title = item.title ?? item.subject;
  return {
    key: agendaKey(sessionId, item.id),
    kind: 'agenda',
    updatedAtMs,
    identity: {
      kind: 'agenda',
      id: item.id,
      sessionId,
      title: scrub(title),
      state,
      standing:
        resolved === undefined
          ? openStanding(item)
          : resolved.disposition === 'done'
            ? 'addressed'
            : resolved.disposition,
      updatedAt: new Date(updatedAtMs).toISOString(),
    },
    fields: fieldsOf(scrub, [
      ['id', item.id],
      ['title', title],
      ['ask', item.title === undefined ? undefined : item.subject],
      ['premise', item.premise],
      ['context', item.context],
      [
        'body',
        joined([
          item.why,
          item.howToResolve,
          item.decided,
          item.stillOpen,
          item.impact,
          item.recommendation?.decision,
          item.recommendation?.why,
          ...(item.questions ?? []).map(question => question.question),
        ]),
      ],
      ['history', joined((item.history ?? []).map(entry => entry.note))],
      ['resolution', resolved === undefined ? undefined : joined([resolved.resolutionNote, responseText(resolved)])],
    ]),
  };
};

/** Every findable item of one session's agenda. */
export const ledgerDocuments = (ledger: AgendaLedger, scrub: ScrubText): readonly WorkDocument[] =>
  ledger.entries.flatMap(entry => {
    const document =
      entry.lifecycle === 'active'
        ? itemDocument(ledger.sessionId, entry.item, undefined, scrub)
        : itemDocument(ledger.sessionId, entry.item, entry.item, scrub);
    return document === undefined ? [] : [document];
  });
