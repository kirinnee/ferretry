/** What the Shells step decides and says, from the one read it makes. No React, no daemon. */
import type { NixFacts } from '../../../contract/index.ts';

/** What the page found out: nix's answer, or that the check itself failed. */
export type NixCheck = { readonly kind: 'facts'; readonly facts: NixFacts } | { readonly kind: 'unreadable' };

/**
 * `hide`: nix is on the machine, so there is nothing to ask. `show`: say what ferrets use instead (`missing`), or that
 * the check itself failed (`unreadable`): a failed request proves nothing about nix, so the page says it could not
 * check and offers another look rather than claiming ferrets use the machine's tools.
 */
export type ShellsStepView =
  | { readonly kind: 'hide' }
  | {
      readonly kind: 'show';
      readonly outcome: 'missing' | 'unreadable';
      readonly line: string;
      /** The daemon's own words for what ferrets do without nix, and how to get it. Empty when the check failed. */
      readonly consequence: string;
      readonly remedy: string;
    };

/** The daemon words a sentence: a capital to start, a full stop to end. */
function sentence(words: string): string {
  const text = words.trim();
  if (text === '') return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
}

export function shellsStepView(check: NixCheck): ShellsStepView {
  if (check.kind === 'facts' && check.facts.present) return { kind: 'hide' };
  if (check.kind === 'facts' && !check.facts.present)
    return {
      kind: 'show',
      outcome: 'missing',
      line: 'Nix is not on this machine.',
      consequence: sentence(check.facts.consequence),
      remedy: sentence(check.facts.remedy),
    };
  return {
    kind: 'show',
    outcome: 'unreadable',
    line: 'Couldn’t check whether nix is on this machine.',
    consequence: '',
    remedy: 'Check again, or look any time in Settings › Shells.',
  };
}
