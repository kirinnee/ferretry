/**
 * `fy card patch` and `fy card show --yaml` (docs/board.md § Patch: a card as one document).
 *
 * A card's words are ONE editable document. `cardPatchDocument` prints it with its revision; `composeCardPatch` reads
 * a patch against the card as it stands, refusing one written against an older revision (read before write), and
 * composes the ONE `edit` action carrying what differs: the same action, validation and governance as `fy card edit`,
 * never a second write path. Pure.
 */
import {
  CARD_PATCH_KEYS,
  type Card,
  type CardActionRequestInput,
  type CardPatch,
  CardPatchSchema,
  cardRevision,
} from '../../contract/index.ts';
import { cardTitleIssue } from './card-title.ts';
import { patchProblems, readPatchText, samePatchValue } from './patch-document.ts';

type CardWords = Pick<
  Card,
  'title' | 'summary' | 'premise' | 'context' | 'terms' | 'brief' | 'howToTest' | 'visibility' | 'progress' | 'history'
>;

type WordKey = Exclude<keyof CardPatch, 'revision'>;

const WORD_KEYS = CARD_PATCH_KEYS.filter((key): key is WordKey => key !== 'revision');

/** The card as the document `patch` takes back: its revision, then every field it changes ("" when empty). */
export function cardPatchDocument(card: CardWords): Record<string, unknown> {
  return {
    revision: cardRevision(card),
    ...Object.fromEntries(
      WORD_KEYS.flatMap(key => {
        const value = card[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

/** A patch's text, parsed: the document, or every problem in it, one line each. */
export function parseCardPatch(
  text: string,
  source: string,
): { readonly ok: true; readonly patch: CardPatch } | { readonly ok: false; readonly problems: readonly string[] } {
  const read = readPatchText(text, source);
  if (!read.ok) return { ok: false, problems: [read.problem] };
  if (!('revision' in read.value)) {
    return {
      ok: false,
      problems: [
        'revision: required — read the whole card first (card show <id> --yaml prints it), so no part is left out of date',
      ],
    };
  }
  const parsed = CardPatchSchema.safeParse(read.value);
  if (!parsed.success) return { ok: false, problems: patchProblems(parsed.error, CARD_PATCH_KEYS) };
  if (WORD_KEYS.every(key => parsed.data[key] === undefined)) {
    return { ok: false, problems: [`${source} names no field to change: a patch changes at least one`] };
  }
  const title = parsed.data.title;
  const titleProblem = title === undefined ? null : cardTitleIssue(title);
  if (titleProblem !== null) return { ok: false, problems: [`title: ${titleProblem}`] };
  return { ok: true, patch: parsed.data };
}

/** What a card patch asks: the edit to send, nothing (every value matches), or a refusal (read it again). */
export type CardPatchPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'edit'; readonly request: CardActionRequestInput };

/** The ONE edit a patch is against `card`; `stale` when the card has changed since the patch's revision was read. */
export function composeCardPatch(card: CardWords, patch: CardPatch): CardPatchPlan {
  if (patch.revision !== cardRevision(card)) return { kind: 'stale' };
  const fields: Record<string, unknown> = Object.fromEntries(
    WORD_KEYS.flatMap(key => {
      if (key === 'progress') return [];
      const value = patch[key];
      return value === undefined || samePatchValue(value, card[key]) ? [] : [[key, value]];
    }),
  );
  const progress = changedProgressParts(card, patch.progress);
  if (progress !== undefined) fields.progress = progress;
  if (Object.keys(fields).length === 0) return { kind: 'unchanged' };
  return {
    kind: 'edit',
    request: { action: 'edit', revision: patch.revision, ...fields } as CardActionRequestInput,
  };
}

/**
 * The progress parts a patch names that differ from the card's (a card with no progress reads each part as ""): the progress
 * MERGES BY KEY, so only those go, and the daemon merges them into the card's progress inside its write.
 */
function changedProgressParts(
  card: CardWords,
  progress: CardPatch['progress'],
): NonNullable<CardPatch['progress']> | undefined {
  if (progress === undefined) return undefined;
  const parts = (['now', 'doneSoFar', 'next'] as const).flatMap(part => {
    const value = progress[part];
    return value === undefined || value === (card.progress?.[part] ?? '') ? [] : [[part, value] as const];
  });
  return parts.length === 0 ? undefined : Object.fromEntries(parts);
}
