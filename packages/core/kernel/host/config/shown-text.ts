/**
 * What a read of a configuration file SHOWS (cfg-leak, CFG-LEAK-R). Placeholder until the mask is built: shows the text.
 */
import type { AnyConfigDef as ConfigDef } from './claims.ts';

type WithheldReason = 'raw_secret' | 'too_large' | 'unmaskable';

export type ShownConfigText =
  | { readonly kind: 'shown'; readonly text: string; readonly hidden: readonly { readonly line: number }[] }
  | { readonly kind: 'withheld'; readonly reason: WithheldReason };

export function shownConfigText(_def: ConfigDef, _path: string, text: string, _binary: string): ShownConfigText {
  return { kind: 'shown', text, hidden: [] };
}
