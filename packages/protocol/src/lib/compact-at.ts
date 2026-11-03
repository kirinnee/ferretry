import { z } from 'zod';

/**
 * COMPACT MEMORY AT, PER FERRET (docs/compact-at.md): the size, in tokens, at which a ferret's harness squeezes
 * its own conversation. A ferret re-reads its whole context on every step, so a smaller trigger makes steps cheaper
 * at the price of detail kept between squeezes. `auto` leaves the harness's own trigger in charge.
 *
 * The floor is the smallest value Claude Code accepts for its own `/autocompact`; the ceiling is the model's window,
 * which only the daemon knows and checks (see {@link checkCompactAt}).
 */
export const COMPACT_AT_MIN_TOKENS = 100_000;

/** `auto`, or a token count at or above the floor. The one shape that is stored, sent and written in YAML. */
export const CompactAtSchema = z.union([
  z.literal('auto'),
  z
    .number()
    .int()
    .min(COMPACT_AT_MIN_TOKENS, `Compact memory at ${COMPACT_AT_MIN_TOKENS / 1000}k tokens or more.`),
]);
export type CompactAt = z.infer<typeof CompactAtSchema>;

/** The choices a surface offers beside a custom value. */
export const COMPACT_AT_PRESETS = [200_000, 250_000, 400_000] as const;

/** What a person typed (`auto`, `250k`, `250000`, `1m`, `0.4m`) as a value, or the reason it is not one. */
export type CompactAtParse =
  | { readonly ok: true; readonly value: CompactAt }
  | { readonly ok: false; readonly reason: string };

const WORDS = /^(?<number>\d+(?:\.\d+)?)\s*(?<unit>[km]?)$/iu;

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
  const floor = compactAtFloorRefusal(tokens);
  return floor === undefined ? { ok: true, value: tokens } : { ok: false, reason: floor };
}

/** The refusal for a value below the floor, in plain words; `undefined` when it clears it. */
export function compactAtFloorRefusal(tokens: number): string | undefined {
  return tokens >= COMPACT_AT_MIN_TOKENS
    ? undefined
    : `${formatTokens(tokens)} is too small: the lowest is ${formatTokens(COMPACT_AT_MIN_TOKENS)}.`;
}

/**
 * Whether a value fits this model: at or above the floor and no larger than its context window. `window` is absent
 * when the daemon cannot say, in which case only the floor is checked. Returns the refusal, or `undefined`.
 */
export function checkCompactAt(value: CompactAt, window: number | undefined): string | undefined {
  if (value === 'auto') return undefined;
  const floor = compactAtFloorRefusal(value);
  if (floor !== undefined) return floor;
  if (window !== undefined && value > window)
    return `${formatTokens(value)} is larger than this model's ${formatTokens(window)} window, so it could never trigger. Pick ${formatTokens(window)} or less.`;
  return undefined;
}

/** `250k`, `1m`, `1.5m`, `120,500` — the short form a person reads. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString('en-US');
}

/** `Auto` or `250k`, as a surface labels the value. */
export function describeCompactAt(value: CompactAt): string {
  return value === 'auto' ? 'Auto' : formatTokens(value);
}

/** The one line a surface shows beside the control. */
export const COMPACT_AT_TRADE_OFF = 'Smaller = cheaper steps; the ferret keeps less detail between squeezes.';
