/**
 * The owner card for a ferret's proposed sign-in recipe: who and where (from the accounts read), the ferret's reason
 * labelled as the ferret's words, the WHOLE diff, and Approve / Decline. Everything is plain text, never Markdown.
 * The card holds nothing but what the daemon's masked read gave it.
 */

import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { accountTitle, placeTitle } from '../../lib/accounts-screen.ts';
import {
  RECIPE_APPROVE_MEANS,
  RECIPE_GONE_WORDS,
  RECIPE_STALE_WORDS,
  RECIPE_UNREAD_WORDS,
  type RecipeProposalView,
} from '../../lib/recipe-proposal-card.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { RecipeDiff } from '../accounts/recipe-diff.tsx';
import { RuleEditWarning } from '../accounts/sign-in-rule-panel.tsx';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';

export type RecipeCardPhase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'unread' }
  | { readonly kind: 'open'; readonly view: RecipeProposalView }
  | { readonly kind: 'saving'; readonly view: RecipeProposalView; readonly decision: 'approve' | 'decline' }
  | { readonly kind: 'done'; readonly ok: boolean; readonly words: string }
  /** `refused`: this device may not answer at all, so neither button can work; the words say where to answer. */
  | { readonly kind: 'failed'; readonly view: RecipeProposalView; readonly words: string; readonly refused: boolean };

export interface RecipeProposalCardProps {
  readonly phase: RecipeCardPhase;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onRetry?: () => void;
  /** Present only when the machine reports standing sign-in rules: an approval suspends those on this sign-in, and says so. */
  readonly rules?: RulesBinding;
  /** Where Settings › Accounts is, for the quiet "Open in Settings" link; absent draws no link. */
  readonly settings?: { readonly href: string; readonly onOpen: (to: string) => void };
}

const viewOf = (phase: RecipeCardPhase): RecipeProposalView | undefined =>
  phase.kind === 'open' || phase.kind === 'saving' || phase.kind === 'failed' ? phase.view : undefined;

export function RecipeProposalCard({
  phase,
  onApprove,
  onDecline,
  onRetry,
  rules,
  settings,
}: RecipeProposalCardProps): ReactNode {
  const settingsLink =
    settings === undefined ? null : (
      <RouteLink
        className="text-meta text-muted underline"
        data-recipe-settings=""
        onNavigate={settings.onOpen}
        to={settings.href}
      >
        Open in Settings
      </RouteLink>
    );
  const view = viewOf(phase);
  const state = phase.kind === 'open' ? phase.view.kind : phase.kind;
  if (phase.kind === 'checking') {
    return (
      <p className="m-0 text-cell text-muted" data-recipe-card="" data-recipe-state="checking" role="status">
        Reading the suggestion…
      </p>
    );
  }
  if (phase.kind === 'unread') {
    return (
      <section className="flex min-w-0 flex-col gap-2" data-recipe-card="" data-recipe-state="unread">
        <p className="m-0 text-cell text-warn" role="status">
          {RECIPE_UNREAD_WORDS}
        </p>
        {onRetry === undefined ? null : (
          <div className="flex flex-wrap gap-2">
            <button className="kt-btn min-h-[44px]" data-recipe-retry="" onClick={onRetry} type="button">
              Try again
            </button>
          </div>
        )}
        {settingsLink}
      </section>
    );
  }
  if (phase.kind === 'done') {
    return (
      <p
        className={`m-0 text-ui ${phase.ok ? 'text-ok' : 'text-muted'}`}
        data-recipe-card=""
        data-recipe-done=""
        data-recipe-state="done"
        role="status"
      >
        {phase.words}
      </p>
    );
  }
  if (view === undefined || view.kind === 'gone') {
    return (
      <p className="m-0 text-cell text-muted" data-recipe-card="" data-recipe-state="gone" role="status">
        {RECIPE_GONE_WORDS}
      </p>
    );
  }

  const busy = phase.kind === 'saving';
  const refused = phase.kind === 'failed' && phase.refused;
  const where = placeTitle(view.signIn.place);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-recipe-card="" data-recipe-state={state}>
      <h3 className="m-0 min-w-0 break-words text-ui font-semibold text-fg" data-recipe-subject="">
        Change how ferrets sign in to {where}?
      </h3>
      {view.account === undefined ? null : (
        <p className="m-0 min-w-0 break-words text-cell text-fg" data-recipe-account="">
          Account: {accountTitle(view.account)}
        </p>
      )}
      <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell text-fg" data-recipe-why="">
        <span className="font-semibold">The ferret says:</span> {view.proposal.why}
      </p>
      <RecipeDiff base={view.proposal.base} recipe={view.proposal.recipe} />
      {view.kind === 'stale' ? (
        <p className="m-0 text-cell text-warn" data-recipe-stale="" role="status">
          {RECIPE_STALE_WORDS}
        </p>
      ) : (
        <p className="m-0 text-meta text-muted" data-recipe-means="">
          {RECIPE_APPROVE_MEANS}
        </p>
      )}
      {rules === undefined || view.kind !== 'ready' ? null : <RuleEditWarning rules={rules} signIn={view.signIn.id} />}
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-recipe-failed="" role="alert">
          {phase.words}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          className="kt-btn min-h-[44px]"
          data-recipe-decline=""
          disabled={busy || refused}
          onClick={onDecline}
          type="button"
        >
          <X aria-hidden="true" size={14} /> {busy && phase.decision === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <button
          className="kt-btn min-h-[44px] justify-center"
          data-recipe-approve=""
          data-variant="primary"
          disabled={busy || refused || view.kind !== 'ready'}
          onClick={onApprove}
          type="button"
        >
          <Check aria-hidden="true" size={14} /> {busy && phase.decision === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
      {settingsLink === null ? null : <div className="flex justify-end">{settingsLink}</div>}
    </section>
  );
}
