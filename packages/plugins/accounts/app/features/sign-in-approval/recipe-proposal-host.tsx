/**
 * Reads the proposal a recipe ask points at (`recipe-proposal`: a sign-in id and a proposal id) from the owner-only account
 * list and answers it through the SAME owner-only route Settings uses. The read is quiet, so a daemon that wants the step-up
 * shows "Confirm it's you to see this" and the owner's press reads again; the answer is the owner's own act and may ask for
 * the passkey. A daemon that cannot show the proposal draws a line saying where to answer it.
 */

import { useEffect, useRef, useState } from 'react';
import type { SignInId } from '../../../contract/routes/index.ts';
import { isStepUpRefusal } from '../../lib/step-up-refusal.ts';
import { recipeCardModel, type RecipeCardModel } from '../../lib/recipe-proposal-card.ts';
import { type AccountsClient, decideProposal, readAccounts } from '../accounts/accounts-api.ts';
import { ConfirmToSee } from '../confirm-to-see.tsx';
import { RecipeProposalCard } from './recipe-proposal-card.tsx';

export interface RecipeProposalHostProps {
  readonly client: AccountsClient;
  readonly signIn: SignInId;
  readonly proposal: string;
}

export function RecipeProposalHost({ client, signIn, proposal }: RecipeProposalHostProps) {
  const [model, setModel] = useState<RecipeCardModel | null>(null);
  const [locked, setLocked] = useState(false);
  const [reads, setReads] = useState(0);
  /** Set by the owner's press on "Confirm it's you": the next read is theirs, so it may ask for the passkey. */
  const pressed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read when the owner confirms
  useEffect(() => {
    setModel(null);
    setLocked(false);
    let current = true;
    const owned = pressed.current;
    pressed.current = false;
    void readAccounts(client, { quiet: !owned }).then(
      list => {
        if (current) setModel(recipeCardModel(list, signIn, proposal));
      },
      (cause: unknown) => {
        if (!current) return;
        if (isStepUpRefusal(cause)) setLocked(true);
        else setModel({ kind: 'unreadable' });
      },
    );
    return () => {
      current = false;
    };
  }, [client, signIn, proposal, reads]);

  if (locked)
    return (
      <ConfirmToSee
        onConfirm={() => {
          pressed.current = true;
          setReads(count => count + 1);
        }}
      />
    );
  if (model === null) return null;
  return (
    <RecipeProposalCard
      model={model}
      onDecide={async (shown, decision) => {
        await decideProposal(
          client,
          shown.signIn,
          shown.proposal,
          decision,
          decision === 'approve' ? shown.pin : undefined,
        );
      }}
    />
  );
}
