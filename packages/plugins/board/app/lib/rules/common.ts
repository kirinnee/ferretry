import { z } from 'zod';

/** An ISO-8601 instant with an explicit timezone. */
export const InstantSchema = z.iso.datetime({ offset: true });
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;
const NESTED_MARKER = /^(\s*(?:[-*•]|\d+[.)])\s+)(?:(?:[-*•]|\d+[.)])\s+)+/u;

/** Text already written as bullets with a second marker inside a point ("- - x") loses the extra one; anything else is kept. */
export const unnestBullets = (text: string): string => {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  if (lines.length === 0 || !lines.every(line => LIST_MARKER.test(line))) return text;
  return text.replaceAll(new RegExp(NESTED_MARKER.source, 'gmu'), '$1');
};

/** An agenda item id on one ferret's ledger (`A<n>`). */
export const AgendaIdSchema = z.string().min(1);
