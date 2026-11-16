/**
 * WHAT A PIECE OF WORK SAYS, as work search indexes it: a card or an ask turned into a few named fields of plain text
 * (docs/work-search.md § What is indexed).
 *
 * THE FIELDS ARE A WHITELIST. Each one is text the owner already reads on the card or the ask; nothing is indexed by
 * walking an object, so a field added to either later is NOT searchable until a source names it on purpose. An input
 * request's card carries its label and never a value, and every text passes through the secret redactor before it
 * reaches the index: the caller hands in the scrub, so a document cannot be built from unscrubbed text by accident.
 *
 * WHO BUILDS THEM. Conversation does not read the Board or the Asks store: each source (`WorkSource`) hands over its
 * work as {@link RawWork}, with the same object while a piece of work has not changed, and this module scrubs and shapes
 * it. Plain notices are not asks and are not offered.
 */
import type { z } from 'zod';
import type { RawWork, WorkFieldSchema, WorkIdentity, WorkKind } from '../../../contract/index.ts';

export type { RawWork };

/** The named pieces of text a piece of work is searched by (the contract's list). */
export type WorkField = z.infer<typeof WorkFieldSchema>;

/** One named piece of a document's text. */
interface WorkDocumentField {
  readonly field: WorkField;
  readonly text: string;
}

/** One indexed piece of work. */
export interface WorkDocument {
  /** `card:F303`, or `ask:A3`. */
  readonly key: string;
  readonly kind: WorkKind;
  readonly identity: WorkIdentity;
  readonly updatedAtMs: number;
  readonly fields: readonly WorkDocumentField[];
}

/** Masks known secret values in one text. The redactor's scrub, for the duration of one indexing batch. */
export type ScrubText = (text: string) => string;

export const cardKey = (id: string): string => `card:${id}`;
export const askKey = (id: string): string => `ask:${id}`;

/** Fields in a fixed order, empties dropped, every text scrubbed. */
const fieldsOf = (scrub: ScrubText, pairs: RawWork['fields']) =>
  pairs.flatMap(([field, text]): WorkDocumentField[] => {
    const trimmed = text?.trim() ?? '';
    return trimmed.length === 0 ? [] : [{ field, text: scrub(trimmed) }];
  });

export const instantMs = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
};

/** A piece of work as a document: the title and every field scrubbed. */
export const workDocument = (raw: RawWork, scrub: ScrubText): WorkDocument => ({
  key: raw.key,
  kind: raw.kind,
  updatedAtMs: raw.updatedAtMs,
  identity: { ...raw.identity, title: scrub(raw.identity.title) } as WorkIdentity,
  fields: fieldsOf(scrub, raw.fields),
});
