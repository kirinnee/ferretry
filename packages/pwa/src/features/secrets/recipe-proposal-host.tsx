/**
 * A ferret's suggested sign-in recipe (`recipeProposal` on an agenda item), fetched and answered where it is suggested.
 * The card is drawn ONLY from that daemon-set ref: a ferret's plain item with the same words draws plain. The steps, the
 * ferret's reason and what Ferretry saw come from the secrets-gated accounts listing, never from the item's text. A
 * device that may not read accounts, or a proposal the daemon no longer holds, draws nothing here and the item is the
 * plain card it always was (its changed lines and the Settings link).
 *
 * The answer is the same route Settings uses, so approving from a paired device asks for a passkey (the carrier does
 * it) and a stale proposal is refused. The daemon closes the agenda card itself once the answer lands; this host holds
 * the chat view while the owner edits, an answer is on its way or the steps are being read again (`onHold`), then
 * closes it with its own words.
 */

import type { AccountList, AgendaItem, LoginRecipeDecision } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useClaimPlanForm } from '../agenda/plan-form-claim.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { decideRecipeProposal, type InputClient, readAccounts } from '../../lib/input-api.ts';
import {
  baseIsObsolete,
  decisionFailureWords,
  doneWords,
  type FoundRecipeProposal,
  findRecipeProposal,
  isStaleProposal,
  RECIPE_OBSOLETE_WORDS,
  RECIPE_STALE_WORDS,
  recipeChange,
} from '../../lib/recipe-proposal.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { RecipeProposalCard } from './recipe-proposal-card.tsx';

export interface RecipeProposalHostProps {
  readonly connection: DaemonConnection;
  readonly item: Pick<AgendaItem, 'recipeProposal'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  /**
   * Whether this form holds the view it is drawn in (#B147): `true` while the owner edits, while an answer is on its
   * way and while the steps are read again; `false` with the words it settled in once there is nothing more to show. Called only when it changes.
   */
  readonly onHold?: (holding: boolean, settled?: string) => void;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly client: InputClient; readonly found: FoundRecipeProposal }
  | { readonly kind: 'plain' };

export function RecipeProposalHost({
  connection,
  item,
  agentName,
  createClient: injected,
  onHold,
}: RecipeProposalHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const ref = item.recipeProposal;
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const signIn = ref?.signIn;
  const proposalId = ref?.id;
  useEffect(() => {
    if (signIn === undefined || proposalId === undefined) {
      setRead({ kind: 'plain' });
      return undefined;
    }
    let current = true;
    setRead({ kind: 'loading' });
    void createClient(connection)
      .then(async client => ({ client, accounts: await readAccounts(client) }))
      .then(
        ({ client, accounts }) => {
          if (!current) return;
          const found = findRecipeProposal(accounts, { signIn, id: proposalId });
          setRead(found === undefined ? { kind: 'plain' } : { kind: 'open', client, found });
        },
        () => {
          // A device that may not read accounts is refused every time, and any other failure is no better: the plain card.
          if (current) setRead({ kind: 'plain' });
        },
      );
    return () => {
      current = false;
    };
  }, [connection, createClient, signIn, proposalId]);

  useClaimPlanForm(read.kind === 'plain' ? 'fallback' : 'owns');

  const holding = editing !== null || sending || refreshing;
  const told = useRef<string | null>(null);
  const hold = useRef(onHold);
  hold.current = onHold;
  useEffect(() => {
    const said = `${holding}\u0000${done ?? ''}`;
    if (told.current === said || (told.current === null && !holding && done === null)) return;
    told.current = said;
    hold.current?.(holding, holding || done === null ? undefined : done);
  }, [holding, done]);

  const readAgain = useCallback(
    async (client: InputClient): Promise<void> => {
      if (signIn === undefined || proposalId === undefined) return;
      let accounts: AccountList | undefined;
      try {
        accounts = await readAccounts(client);
      } catch {
        accounts = undefined;
      }
      if (!alive.current) return;
      const found = accounts === undefined ? undefined : findRecipeProposal(accounts, { signIn, id: proposalId });
      if (found === undefined) {
        setGone(true);
        setEditing(null);
      } else setRead({ kind: 'open', client, found });
    },
    [signIn, proposalId],
  );

  if (read.kind === 'loading')
    return (
      <p className="m-0 text-ui text-muted" data-recipe-loading="" role="status">
        Reading the suggested steps…
      </p>
    );
  if (read.kind === 'plain' || signIn === undefined || proposalId === undefined) return null;
  if (done !== null)
    return (
      <p className="m-0 text-ui text-ok" data-recipe-done="" role="status">
        {done}
      </p>
    );

  const { client, found } = read;
  // Once the daemon has refused the suggestion as stale, the steps are weighed against what it holds now.
  const change = recipeChange(stale ? found.signIn.recipe : found.proposal.base, found.proposal.recipe);
  const obsolete = stale && !refreshing && !gone && baseIsObsolete(found);

  const decide = async (decision: LoginRecipeDecision): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError(undefined);
    try {
      await decideRecipeProposal(client, signIn, proposalId, decision);
    } catch (cause) {
      if (!alive.current) return;
      setSending(false);
      if (isStaleProposal(cause)) {
        setStale(true);
        setRefreshing(true);
        await readAgain(client);
        if (alive.current) setRefreshing(false);
      } else setError(decisionFailureWords(cause));
      return;
    }
    if (!alive.current) return;
    setSending(false);
    setEditing(null);
    setStale(false);
    setDone(doneWords(decision.decision, found.place));
  };

  return (
    <RecipeProposalCard
      blocked={obsolete}
      busy={sending || refreshing}
      change={change}
      closed={gone}
      editing={editing}
      ferret={agentName ?? 'The ferret'}
      observed={found.signIn.observed ?? []}
      onApprove={() => void decide({ decision: 'approve' })}
      onApproveMine={() => editing !== null && void decide({ decision: 'approve', recipe: editing })}
      onCancel={() => {
        setEditing(null);
        setError(undefined);
      }}
      onDecline={() => void decide({ decision: 'decline' })}
      onEdit={() => {
        setError(undefined);
        setEditing(found.proposal.recipe);
      }}
      onText={setEditing}
      place={found.place}
      version={found.signIn.recipeVersion}
      why={found.proposal.why}
      {...(stale ? { stale: obsolete ? RECIPE_OBSOLETE_WORDS : RECIPE_STALE_WORDS } : {})}
      {...(obsolete ? { settings: `${daemonSettingsPath(connection.daemonId)}#accounts` } : {})}
      {...(error === undefined ? {} : { error })}
    />
  );
}
