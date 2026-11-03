/**
 * "Don’t ask again for this sign-in ▰▱ 1 of 2 sign-ins done", on the open password card. It reads the daemon's
 * eligibility for the sign-in the card offers and draws ONLY when the daemon says the owner is part-way there
 * (`no-history` with a count): ready, another reason, an older daemon that sent no count and a failed read all draw
 * nothing, so it never says anything the sheet would not. It holds nothing: the card closes with its Send as usual, and a
 * sign-in that is ready is offered after Send by `SignInRuleOffer`.
 */

import type { SignInSummary } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import {
  RULE_PROGRESS_WHY,
  type RuleClient,
  type RuleReadiness,
  readEligibility,
  ruleReadiness,
} from '../../lib/sign-in-rules.ts';
import { SignInRuleProgress } from '../accounts/sign-in-rule-progress.tsx';

export interface SignInRuleProgressLineProps {
  readonly client: RuleClient;
  readonly signIn: SignInSummary['id'];
}

export function SignInRuleProgressLine({ client, signIn }: SignInRuleProgressLineProps) {
  const [readiness, setReadiness] = useState<RuleReadiness | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setReadiness(undefined);
    void readEligibility(client, signIn).then(
      answer => {
        if (current) setReadiness(ruleReadiness(answer));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client, signIn]);

  if (readiness?.kind !== 'not-yet') return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border bg-surface p-3"
      data-rule-progress-line=""
    >
      <SignInRuleProgress history={readiness.history} lead="Don’t ask again for this sign-in" words={readiness.words} />
      <p className="m-0 text-meta text-muted" data-rule-progress-why="">
        {RULE_PROGRESS_WHY}
      </p>
    </div>
  );
}
