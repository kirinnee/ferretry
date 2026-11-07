import { type CompactAt } from './wire-compact.ts';
import { COMPACT_AT_MIN_TOKENS } from './wire-compact.ts';

/** The rules around a ferret's compact-at value (today's `compact-at.ts`, the part that is not a schema). */
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
