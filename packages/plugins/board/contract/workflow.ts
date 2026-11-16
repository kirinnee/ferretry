/** The small card vocabulary every board schema shares: a card's kind, title, workflow and the owner's words. */
import { z } from 'zod';

export const MAX_CARD_TITLE_LENGTH = 200;
export const MAX_CARD_MESSAGE_LENGTH = 64 * 1024;
export const MAX_CARD_SOURCE_LENGTH = 2 * 1024;

export const CardKindSchema = z.enum(['bug', 'feature', 'infra', 'chore']);
export type CardKind = z.infer<typeof CardKindSchema>;

/** The id prefix a kind's cards carry: `F` for a feature. Kind is immutable because the prefix must match. */
export const CARD_KIND_PREFIX: Readonly<Record<CardKind, string>> = { bug: 'B', feature: 'F', infra: 'I', chore: 'C' };

/** A card's title: at most five words, so reading it directly says what the work is doing. */
export const CardTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CARD_TITLE_LENGTH)
  .refine(value => value.split(/\s+/u).length <= 5, 'title must contain at most five words');
export type CardTitle = z.infer<typeof CardTitleSchema>;

/** Selects the lane variant. Immutable after create. */
export const WorkflowSchema = z.enum(['quick', 'design-first', 'research-first', 'investigate']);
export type Workflow = z.infer<typeof WorkflowSchema>;

/** The owner's words, verbatim, and where they were said. Never paraphrased. */
export const CardMessageSchema = z.object({
  text: z.string().min(1).max(MAX_CARD_MESSAGE_LENGTH),
  source: z.string().min(1).max(MAX_CARD_SOURCE_LENGTH),
});
export type CardMessage = z.infer<typeof CardMessageSchema>;

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;
const NESTED_MARKER = /^(\s*(?:[-*•]|\d+[.)])\s+)(?:(?:[-*•]|\d+[.)])\s+)+/u;

/** Text already written as bullets with a second marker inside a point ("- - x") loses the extra one; anything else is kept. */
export const unnestBullets = (text: string): string => {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  if (lines.length === 0 || !lines.every(line => LIST_MARKER.test(line))) return text;
  return text.replaceAll(new RegExp(NESTED_MARKER.source, 'gmu'), '$1');
};

/** One point without its leading list marker ("- ", "* ", "• ", "1. "): a point is a plain line, the list adds the bullet. */
export const stripListMarker = (point: string): string => {
  const stripped = point.replace(LIST_MARKER, '').trim();
  return stripped === '' ? point.trim() : stripped;
};

/** A list of short points as markdown bullets, one per line; blank points are dropped, a stray leading marker is not doubled. */
export const toBullets = (points: readonly string[]): string =>
  points
    .map(point => stripListMarker(point.replaceAll(/\s+/gu, ' ').trim()))
    .filter(point => point !== '')
    .map(point => `- ${point}`)
    .join('\n');
