import { z } from 'zod';

/**
 * COMPACT MEMORY AT, PER FERRET (docs/compact-at.md): the size, in tokens, at which a ferret's harness squeezes
 * its own conversation. A ferret re-reads its whole context on every step, so a smaller trigger makes steps cheaper
 * at the price of detail kept between squeezes. `auto` leaves the harness's own trigger in charge.
 *
 * The floor is the smallest value Claude Code accepts for its own `/autocompact`; the ceiling is the model's window,
 * which only the daemon knows and checks (see {@link checkCompactAt}).
 * @pending ferrets: Actions rows still to port: compact-at
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

/**
 * The choices a surface offers beside a custom value.
 * @pending ferrets: Actions rows still to port: compact-at
 */
export const COMPACT_AT_PRESETS = [200_000, 250_000, 400_000] as const;

/**
 * The refusal for a value below the floor, in plain words; `undefined` when it clears it.
 * @pending ferrets: Actions rows still to port: compact-at
 */
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

/**
 * `250k`, `1m`, `1.5m`, `120,500` — the short form a person reads.
 * @pending ferrets: Actions rows still to port: compact-at
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString('en-US');
}

/** `Auto` or `250k`, as a surface labels the value. */
export function describeCompactAt(value: CompactAt): string {
  return value === 'auto' ? 'Auto' : formatTokens(value);
}

/**
 * The one line a surface shows beside the control.
 * @pending ferrets: Actions rows still to port: compact-at
 */
export const COMPACT_AT_TRADE_OFF = 'Smaller = cheaper steps; the ferret keeps less detail between squeezes.';
