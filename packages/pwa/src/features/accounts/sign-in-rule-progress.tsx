/**
 * How far a sign-in is from a standing rule: one pill per fill the owner still has to make by hand, then the daemon's
 * "1 of 2 sign-ins done". The words come from the protocol and the count from the daemon's eligibility answer; the pills
 * only repeat them, so they are hidden from a screen reader.
 */

import { RULE_PROGRESS_TAPS } from '../../lib/sign-in-rules.ts';

export interface SignInRuleProgressProps {
  readonly history: number;
  readonly words: string;
  /** What the line is about, ahead of the pills ("Not yet", "Don’t ask again for this sign-in"). */
  readonly lead?: string;
}

export function SignInRuleProgress({ history, words, lead }: SignInRuleProgressProps) {
  return (
    <p
      className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-cell font-medium text-fg"
      data-rule-progress={history}
    >
      {lead === undefined ? null : <span className="min-w-0 break-words">{lead}</span>}
      <span aria-hidden="true" className="inline-flex items-center gap-1" data-rule-progress-pills="">
        {Array.from({ length: RULE_PROGRESS_TAPS }, (_, index) => index + 1).map(position => (
          <span
            className={`inline-block h-2 w-6 rounded-full ${position <= history ? 'bg-ok' : 'bg-border-strong'}`}
            data-done={position <= history ? '' : undefined}
            key={position}
          />
        ))}
      </span>
      <span className="font-normal text-muted" data-rule-progress-words="">
        {words}
      </span>
    </p>
  );
}
