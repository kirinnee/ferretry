/**
 * A ferret's suggested sign-in recipe, drawn on its ask card with the owner's two answers. Everything on it is the daemon's
 * masked answer about that proposal, drawn as plain text: the account and place, "The ferret says: …" and the WHOLE change.
 * "Approve" is offered only while the recipe is still the one the ferret changed; "Decline" always is.
 */

import { useState } from 'react';
import { Check, X } from '../../shell.tsx';
import { RECIPE_CARD_WORDS, type RecipeCardModel } from '../../lib/recipe-proposal-card.ts';
import { RecipeDiff } from '../accounts/recipe-diff.tsx';

type Ready = Extract<RecipeCardModel, { readonly kind: 'ready' | 'stale' }>;

export interface RecipeProposalCardProps {
  readonly model: RecipeCardModel;
  /** Sends the owner's answer. Rejects with the daemon's words. */
  readonly onDecide: (model: Ready, decision: 'approve' | 'decline') => Promise<void>;
}

export function RecipeProposalCard({ model, onDecide }: RecipeProposalCardProps) {
  const [settled, setSettled] = useState<'approve' | 'decline' | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (model.kind === 'gone' || model.kind === 'unreadable')
    return (
      <p className="m-0 min-w-0 break-words text-cell text-muted" data-recipe-proposal-state={model.kind}>
        {RECIPE_CARD_WORDS[model.kind]}
      </p>
    );
  if (settled !== null)
    return (
      <p className="m-0 min-w-0 break-words text-cell text-fg" data-recipe-proposal-state="done">
        {settled === 'approve' ? RECIPE_CARD_WORDS.approved : RECIPE_CARD_WORDS.declined}
      </p>
    );

  const answer = async (decision: 'approve' | 'decline'): Promise<void> => {
    setSending(true);
    setFailure(null);
    try {
      await onDecide(model, decision);
      setSettled(decision);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-recipe-proposal={model.proposal}
      data-recipe-proposal-state={model.kind}
    >
      <p className="m-0 min-w-0 break-words text-ui font-medium text-fg" data-recipe-proposal-where="">
        {model.who} · {model.place}
      </p>
      <p className="m-0 min-w-0 break-words text-cell text-fg" data-recipe-proposal-why="">
        The ferret says: {model.why}
      </p>
      <RecipeDiff base={model.base} recipe={model.recipe} />
      {model.kind === 'stale' ? (
        <p className="m-0 min-w-0 break-words text-cell text-warn" data-recipe-proposal-stale="">
          {RECIPE_CARD_WORDS.stale}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {model.kind === 'ready' ? (
          <button
            className="kt-btn min-h-[44px]"
            data-recipe-proposal-approve=""
            data-variant="primary"
            disabled={sending}
            onClick={() => void answer('approve')}
            type="button"
          >
            <Check aria-hidden="true" size={14} /> Approve
          </button>
        ) : null}
        <button
          className="kt-btn min-h-[44px]"
          data-recipe-proposal-decline=""
          disabled={sending}
          onClick={() => void answer('decline')}
          type="button"
        >
          <X aria-hidden="true" size={14} /> Decline
        </button>
      </div>
      {failure === null ? null : (
        <p className="m-0 min-w-0 break-words text-cell text-err" data-recipe-proposal-refused="" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
