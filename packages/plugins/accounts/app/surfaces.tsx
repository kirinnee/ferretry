import type { RendererProps } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { TwoFactorStageIdSchema } from '../contract/routes/index.ts';
import { AccountsSurface } from './features/accounts/accounts-surface.tsx';
import { TwoFactorSeedHost } from './features/two-factor/two-factor-seed-host.tsx';
import type { AccountsClient } from './shell.tsx';

/** Settings › ‹machine› › Accounts: sign-ins, saved logins and 2FA keys (today's Accounts screen). */
export function accountsTab(client: AccountsClient) {
  return function AccountsTab() {
    return <AccountsSurface client={client} />;
  };
}

/** What the renderer reads off an ask: its ref (the source's own), and the daemon's words. */
const AskOnScreenSchema = z.object({
  ref: z.unknown(),
  subject: z.string().optional(),
  why: z.string().optional(),
  context: z.string().optional(),
});
const SeedRefSchema = z.object({ kind: z.literal('two-factor-seed'), stage: TwoFactorStageIdSchema });

/**
 * `ask:sign-in-approval`: a staged 2FA seed is half a's owner card (today's agenda seed card). Every other kind is half
 * b's (sign-in rules, task plans, paste rules, recipes) and has no app view yet: the ask's own words, and where to answer.
 */
export function signInApprovalRenderer(client: AccountsClient) {
  return function SignInApproval({ value }: RendererProps) {
    const ask = AskOnScreenSchema.safeParse(value);
    if (!ask.success) return null;
    const seed = SeedRefSchema.safeParse(ask.data.ref);
    if (seed.success)
      return (
        <TwoFactorSeedHost
          client={client}
          item={{
            twoFactorSeed: { stage: seed.data.stage },
            subject: ask.data.subject,
            why: ask.data.why,
            context: ask.data.context,
          }}
        />
      );
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Sign-in approval">
        {ask.data.subject === undefined ? null : (
          <h3 className="m-0 text-row font-semibold text-fg">{ask.data.subject}</h3>
        )}
        {ask.data.why === undefined ? null : (
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{ask.data.why}</p>
        )}
        <p className="mb-0 mt-1 text-cell leading-base text-faint">
          This app cannot answer this yet. Answer it with fy.
        </p>
      </section>
    );
  };
}
