import type { AskBoardSnapshot, AskSummary, AsksApi } from '@ferretry/core-asks/contract';
import { instantMs, type RawWork, askKey } from '../lib/documents.ts';
import type { WorkSource } from '../lib/service.ts';

/** Where an ask stands, in the words the Inbox uses. */
const standing = (ask: AskSummary): string =>
  ask.state === 'open' ? 'open' : ask.state === 'answered' ? 'answered' : 'closed';

type OpenItem = AskBoardSnapshot['items'][number];
type ResolvedItem = AskBoardSnapshot['resolved'][number];

/** The fields of an item's text beyond its subject, as work search reads them (v4's agenda documents). */
type Text = Pick<RawWork, 'fields'>['fields'];

const joined = (parts: readonly (string | null | undefined)[]): string | undefined => {
  const text = parts
    .map(part => part?.trim() ?? '')
    .filter(part => part.length > 0)
    .join('\n');
  return text.length === 0 ? undefined : text;
};

/** What the owner answered, as words: a choice, an answer, a clarification. */
const responseText = (item: ResolvedItem): string | undefined => {
  const response = item.response;
  if (response === undefined) return undefined;
  if (response.kind === 'multiple-choice') return response.choice;
  if (response.kind === 'open-question' || response.kind === 'other') return response.answer;
  if (response.kind === 'answer-review' && response.verdict === 'clarify') return response.clarification;
  return undefined;
};

/**
 * The text of one agenda item: its title and ask, premise, context, the body, what was said along the way and how it
 * ended. Without it an ask is findable by its subject alone, and every other word on the card is lost to the search.
 */
function textOf(item: OpenItem | ResolvedItem, resolved: ResolvedItem | undefined): Text {
  const title = item.title ?? item.subject;
  return [
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
  ];
}

/** The board text of every item, by ferret and id: what an ask's own summary does not carry. */
async function boardText(asks: Partial<Pick<AsksApi, 'snapshots'>>): Promise<ReadonlyMap<string, Text>> {
  const found = new Map<string, Text>();
  if (asks.snapshots === undefined) return found;
  let boards: readonly AskBoardSnapshot[];
  try {
    boards = await asks.snapshots();
  } catch {
    // The summary alone still makes an ask findable by its subject; a board that cannot be read adds nothing.
    return found;
  }
  for (const board of boards) {
    for (const item of board.items) found.set(`${board.sessionId}/${item.id}`, textOf(item, undefined));
    for (const item of board.resolved) found.set(`${board.sessionId}/${item.id}`, textOf(item, item));
  }
  return found;
}

/** An ask as work: its subject, and the rest of the item's text when its board could be read. */
const asWork = (ask: AskSummary, text: Text | undefined): RawWork => ({
  key: askKey(ask.id),
  kind: 'ask',
  updatedAtMs: instantMs(ask.raisedAt),
  identity: {
    kind: 'ask',
    id: ask.id,
    ferret: ask.ferret ?? 'owner',
    title: ask.subject,
    state: ask.state === 'open' ? 'open' : 'closed',
    standing: standing(ask),
    updatedAt: ask.raisedAt,
  },
  fields: [['id', ask.id], ...(text ?? [['title', ask.subject] as const])],
});

/**
 * The asks as a work source, read through the Asks port. The port hands back a fresh summary each time, so a piece of
 * work is kept as the same object while its summary and text read the same: the service re-indexes by identity.
 */
export function asksSource(asks: Pick<AsksApi, 'open'> & Partial<Pick<AsksApi, 'snapshots'>>): WorkSource {
  const kept = new Map<string, { readonly signature: string; readonly work: RawWork }>();
  return {
    id: 'asks',
    list: async () => {
      const listed = (
        await Promise.all((['open', 'answered', 'closed'] as const).map(state => asks.open({ state })))
      ).flat();
      const texts = await boardText(asks);
      const present = new Set<string>();
      const works = listed.map(ask => {
        const text = texts.get(`${ask.ferret ?? 'owner'}/${ask.id}`);
        const work = asWork(ask, text);
        const signature = JSON.stringify([ask, text]);
        const before = kept.get(work.key);
        present.add(work.key);
        if (before?.signature === signature) return before.work;
        kept.set(work.key, { signature, work });
        return work;
      });
      for (const key of [...kept.keys()]) if (!present.has(key)) kept.delete(key);
      return works;
    },
  };
}
