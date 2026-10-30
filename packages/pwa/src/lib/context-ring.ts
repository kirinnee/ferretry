import type { SessionContext } from '@ferretry/protocol';
import { formatTokenCount } from './live-counter.ts';

/** The share of the window from which the ring turns amber, and red. */
const CONTEXT_WARN_PERCENT = 70;
const CONTEXT_ERR_PERCENT = 90;

type ContextTone = 'ok' | 'warn' | 'err';

/** What a person is told about a context size: the ring's tone, its fill and the sentence behind it. */
export interface ContextReadout {
  readonly tone: ContextTone;
  /** The share of the window used, clamped to 0..100 for drawing. */
  readonly fill: number;
  /** `118k of 1M tokens (12%)` — the words for the tooltip, the tap and a screen reader. */
  readonly text: string;
}

/** `1.0M` is `1M`: a window is a round number, and a trailing `.0` reads as a measurement. */
const tokens = (count: number): string => formatTokenCount(count).replace('.0', '');

export function contextReadout(
  context: Pick<SessionContext, 'usedTokens' | 'windowTokens' | 'percent'>,
): ContextReadout {
  const fill = Math.min(100, Math.max(0, context.percent));
  // The tone follows the number a person reads, so `90%` is never drawn amber.
  const shown = Math.round(fill);
  const tone = shown >= CONTEXT_ERR_PERCENT ? 'err' : shown >= CONTEXT_WARN_PERCENT ? 'warn' : 'ok';
  return {
    tone,
    fill,
    text: `${tokens(context.usedTokens)} of ${tokens(context.windowTokens)} tokens (${shown}%)`,
  };
}
