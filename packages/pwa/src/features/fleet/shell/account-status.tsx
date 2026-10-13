/**
 * The account model's four status words, each with its own SHAPE (docs/design/account-model.md §4.1
 * rule 7): ● Ready, ◐ Refresh due, ○ Needs sign-in, ◌ Checking.
 *
 * Shape first, colour second, words always: the glyph is never the only signal, so a reader who
 * cannot tell the tones apart still sees four different marks, and a screen reader hears the word.
 * The same four marks answer "is this machine reachable" on the switcher (● Online, ○ Offline,
 * ◌ Checking), because the prototype draws both with them.
 */

import type { FleetCredentialStatusWord } from '@ferretry/protocol';
import { cn } from '../../../lib/class-names.ts';

interface AccountStatusDefinition {
  readonly glyph: string;
  readonly tone: string;
  readonly label: string;
}

export const ACCOUNT_STATUS_SHAPES: Readonly<Record<FleetCredentialStatusWord, AccountStatusDefinition>> = {
  ready: { glyph: '●', tone: 'text-ok', label: 'Ready' },
  refresh_due: { glyph: '◐', tone: 'text-warn', label: 'Refresh due' },
  needs_sign_in: { glyph: '○', tone: 'text-err', label: 'Needs sign-in' },
  checking: { glyph: '◌', tone: 'text-muted', label: 'Checking' },
};

export interface AccountStatusProps {
  readonly word: FleetCredentialStatusWord;
  /** Overrides the spoken and shown word, e.g. "Online" for a reachable machine. */
  readonly label?: string;
  /** Show the word beside the mark; otherwise it is only spoken and shown on hover. */
  readonly showLabel?: boolean;
  readonly className?: string;
}

export function AccountStatus({ word, label, showLabel = false, className }: AccountStatusProps) {
  const shape = ACCOUNT_STATUS_SHAPES[word];
  const text = label ?? shape.label;
  return (
    <span data-status-shape={word} className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span aria-hidden="true" title={text} className={cn('shrink-0 leading-none', shape.tone)}>
        {shape.glyph}
      </span>
      {showLabel ? <span className="min-w-0 truncate">{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}
