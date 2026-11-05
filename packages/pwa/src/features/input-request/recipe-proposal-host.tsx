/**
 * The ferret's proposed sign-in recipe an agenda item points at (`recipeProposal`), as the owner's card. It reads the
 * sign-in, its account and the proposal from the daemon's owner-only accounts read (never from the item's text), and
 * Approve / Decline answer through the SAME owner-only route Settings › Accounts uses
 * (`POST /v1/accounts/sign-ins/:si/recipe/proposals/:pid`): the daemon re-checks the text for values, refuses a stale
 * approval, audits the change and closes the card. The generic agenda answer approves nothing, so this form is the
 * only answer drawn. A daemon that cannot be read draws the card's own words and says where else to answer.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type InputClient, readAccounts } from '../../lib/input-api.ts';
import {
  RECIPE_APPROVED_WORDS,
  RECIPE_DECLINED_WORDS,
  RECIPE_GONE_WORDS,
  recipeDecideFailureWords,
  recipeProposalView,
} from '../../lib/recipe-proposal-card.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import { decideProposal } from '../accounts/accounts-api.ts';
import { type RecipeCardPhase, RecipeProposalCard } from './recipe-proposal-card.tsx';

export interface RecipeProposalHostProps {
  readonly connection: DaemonConnection;
  readonly item: Pick<AgendaItem, 'recipeProposal'>;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  readonly onDone?: () => void;
}

const codeOf = (cause: unknown): unknown =>
  typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;

export function RecipeProposalHost({ connection, item, createClient: injected, onDone }: RecipeProposalHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const ref = item.recipeProposal;
  const router = useOptionalRouter();
  const [client, setClient] = useState<InputClient | null>(null);
  const [phase, setPhase] = useState<RecipeCardPhase>({ kind: 'checking' });
  const [reads, setReads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` only re-runs the read when the owner presses Try again
  useEffect(() => {
    if (ref === undefined) return undefined;
    let current = true;
    setPhase({ kind: 'checking' });
    void createClient(connection)
      .then(async next => {
        if (!current) return;
        setClient(next);
        const list = await readAccounts(next);
        if (current) setPhase({ kind: 'open', view: recipeProposalView(list, ref) });
      })
      .catch(() => {
        if (current) setPhase({ kind: 'unread' });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, ref, reads]);

  const decide = useCallback(
    async (decision: 'approve' | 'decline'): Promise<void> => {
      if (ref === undefined || client === null) return;
      if (phase.kind !== 'open' && phase.kind !== 'failed') return;
      const { view } = phase;
      if (view.kind === 'gone' || (decision === 'approve' && view.kind !== 'ready')) return;
      setPhase({ kind: 'saving', view, decision });
      try {
        await decideProposal(client, ref.signIn, ref.proposal, decision);
        setPhase({
          kind: 'done',
          ok: decision === 'approve',
          words: decision === 'approve' ? RECIPE_APPROVED_WORDS : RECIPE_DECLINED_WORDS,
        });
        onDone?.();
      } catch (cause) {
        const code = codeOf(cause);
        if (code === 'unknown_proposal') {
          setPhase({ kind: 'done', ok: false, words: RECIPE_GONE_WORDS });
          return;
        }
        // A stale approval: the recipe moved under the owner, so Approve goes and only Decline stays.
        const next = code === 'stale_proposal' ? { ...view, kind: 'stale' as const } : view;
        setPhase({ kind: 'failed', view: next, words: recipeDecideFailureWords(cause) });
      }
    },
    [client, onDone, phase, ref],
  );

  if (ref === undefined) return null;
  return (
    <RecipeProposalCard
      onApprove={() => void decide('approve')}
      onDecline={() => void decide('decline')}
      onRetry={() => setReads(count => count + 1)}
      phase={phase}
      {...(router === null
        ? {}
        : { settings: { href: `${daemonSettingsPath(connection.daemonId)}#accounts`, onOpen: router.navigate } })}
    />
  );
}
