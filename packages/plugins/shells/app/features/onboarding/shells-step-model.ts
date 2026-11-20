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

export function shellsStepView(check: NixCheck): ShellsStepView {
  if (check.kind === 'facts' && check.facts.present) return { kind: 'hide' };
  if (check.kind === 'facts' && !check.facts.present)
    return {
      kind: 'show',
      outcome: 'missing',
      line: 'Nix is not on this machine. A shell gives each ferret its own set of tools, built once and cached.',
      consequence: check.facts.consequence,
      remedy: check.facts.remedy,
    };
  return {
    kind: 'show',
    outcome: 'unreadable',
    line: 'Couldn’t check whether nix is on this machine.',
    consequence: '',
    remedy: 'Check again, or look any time in Settings › Shells.',
  };
}
