import { z } from 'zod';

/**
 * COMPACT MEMORY AT, as `fy new --compact-at` takes it: `auto`, or a token count at or above the floor. Conversation owns
 * the setting on a running ferret; Packs only passes the value a helper is started with.
 */
export const COMPACT_AT_MIN_TOKENS = 100_000;

export const CompactAtSchema = z.union([
  z.literal('auto'),
  z
    .number()
    .int()
    .min(COMPACT_AT_MIN_TOKENS, `Compact memory at ${COMPACT_AT_MIN_TOKENS / 1000}k tokens or more.`),
]);
export type CompactAt = z.infer<typeof CompactAtSchema>;

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString('en-US');
}

export type CompactAtParse =
  | { readonly ok: true; readonly value: CompactAt }
  | { readonly ok: false; readonly reason: string };

const WORDS = /^(?<number>\d+(?:\.\d+)?)\s*(?<unit>[km]?)$/iu;

/** What a person typed (`auto`, `250k`, `250000`, `1m`) as a value, or the reason it is not one. */
export function parseCompactAt(text: string): CompactAtParse {
  const trimmed = text.trim().toLowerCase().replaceAll(',', '').replaceAll('_', '');
  if (trimmed === 'auto') return { ok: true, value: 'auto' };
  const match = WORDS.exec(trimmed);
  const number = match?.groups?.number;
  if (match === null || number === undefined)
    return { ok: false, reason: `“${text.trim()}” is not a size. Use auto, or a token count like 250k or 250000.` };
  const unit = match.groups?.unit ?? '';
  const tokens = Math.round(Number(number) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
  if (!Number.isSafeInteger(tokens)) return { ok: false, reason: `“${text.trim()}” is not a size.` };
  if (tokens < COMPACT_AT_MIN_TOKENS)
    return {
      ok: false,
      reason: `${formatTokens(tokens)} is too small: the lowest is ${formatTokens(COMPACT_AT_MIN_TOKENS)}.`,
    };
  return { ok: true, value: tokens };
}
