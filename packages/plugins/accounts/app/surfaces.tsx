import type { RendererProps } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { SignInApprovalRefSchema } from '../contract/wire.ts';
import { AccountsSurface } from './features/accounts/accounts-surface.tsx';
import { CopyPlanHost } from './features/secure-copy/copy-plan-host.tsx';
import { CopyRulesSurface } from './features/secure-copy/copy-rules-surface.tsx';
import { SignInRuleSuggestionHost } from './features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { SignInRulesSurface } from './features/secure-copy/sign-in-rules-surface.tsx';
import { TaskPlanHost } from './features/secure-copy/task-plan-host.tsx';
import { TaskPlansSurface } from './features/secure-copy/task-plans-surface.tsx';
import { PhoneApprovalHost } from './features/sign-in-approval/phone-approval-host.tsx';
import { TwoFactorSeedHost } from './features/two-factor/two-factor-seed-host.tsx';
import type { AccountsClient } from './shell.tsx';

/** Settings › ‹machine› › Accounts: sign-ins, saved logins and 2FA keys (today's Accounts screen). */
export function accountsTab(client: AccountsClient) {
  return function AccountsTab() {
    return <AccountsSurface client={client} />;
  };
}

/**
 * Settings › ‹machine› › Secure copy: the pastes approved in advance, the task plans live on this machine and the
 * standing sign-in rules (today's Secure copy panel). No passkey ceremony is handed to these views (it is Access's, and
 * not on this base): what only narrows works as it did, and what would widen is refused with today's no-passkey words.
 */
export function secureCopyTab(client: AccountsClient) {
  return function SecureCopyTab() {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <CopyRulesSurface client={client} />
        <TaskPlansSurface client={client} />
        <SignInRulesSurface client={client} />
      </div>
    );
  };
}

/** What the renderer reads off an ask: its ref (the source's own), the ferret it is about, and the daemon's words. */
const AskOnScreenSchema = z.object({
  ref: z.unknown(),
  ferret: z.string().optional(),
  subject: z.string().optional(),
  why: z.string().optional(),
  context: z.string().optional(),
});

/** Where to answer an ask whose kind has no card of its own. */
const ANSWER_ELSEWHERE = {
  'rule-suspended': 'Approve it again under Settings › Secure copy › Standing sign-in rules, or answer it with fy.',
  'recipe-proposal': 'Review the proposal under Settings › Accounts, on the sign-in it names, or answer it with fy.',
} as const;
const PLAIN_FALLBACK = 'Answer it with fy.';

/**
 * `ask:sign-in-approval`: the daemon's own approval cards, drawn only from the daemon-set ref. A staged 2FA seed is the
 * owner's seed card; a task plan, a paste plan, a ferret's rule suggestion and an approve-on-phone push each have their
 * card, read from the daemon by id (never from the ask's text). A suspended rule and a recipe proposal are shown as the
 * daemon's words and where to act, as today's agenda showed them. A ref this half does not know draws plain.
 */
export function signInApprovalRenderer(client: AccountsClient) {
  return function SignInApproval({ value }: RendererProps) {
    const ask = AskOnScreenSchema.safeParse(value);
    if (!ask.success) return null;
    const ref = SignInApprovalRefSchema.safeParse(ask.data.ref);
    const { ferret, subject, why, context } = ask.data;
    if (ref.success) {
      const card = ref.data;
      if (card.kind === 'two-factor-seed')
        return (
          <TwoFactorSeedHost client={client} item={{ twoFactorSeed: { stage: card.stage }, subject, why, context }} />
        );
      if (ferret !== undefined) {
        if (card.kind === 'task-plan')
          return <TaskPlanHost client={client} ferret={ferret} planId={card.planId} agentName={ferret} />;
        if (card.kind === 'copy-plan')
          return <CopyPlanHost client={client} ferret={ferret} planId={card.planId} agentName={ferret} />;
        if (card.kind === 'rule-suggestion')
          return (
            <SignInRuleSuggestionHost
              client={client}
              suggestionId={card.suggestion}
              ferret={ferret}
              agentName={ferret}
            />
          );
        if (card.kind === 'phone-approval')
          return <PhoneApprovalHost client={client} approvalId={card.id} ferret={ferret} />;
      }
    }
    const where =
      ref.success && (ref.data.kind === 'rule-suspended' || ref.data.kind === 'recipe-proposal')
        ? ANSWER_ELSEWHERE[ref.data.kind]
        : PLAIN_FALLBACK;
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Sign-in approval">
        {subject === undefined ? null : <h3 className="m-0 text-row font-semibold text-fg">{subject}</h3>}
        {why === undefined ? null : <p className="mb-0 mt-1 text-cell leading-base text-muted">{why}</p>}
        <p className="mb-0 mt-1 text-cell leading-base text-faint">{where}</p>
      </section>
    );
  };
}
