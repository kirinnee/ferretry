/**
 * The ferret's proposed sign-in recipe an agenda item points at (`recipeProposal`), as the owner's card. It reads the
 * sign-in, its account and the proposal from the daemon's owner-only accounts read (never from the item's text), and
 * Approve / Decline answer through the SAME owner-only route Settings › Accounts uses
 * (`POST /v1/accounts/sign-ins/:si/recipe/proposals/:pid`): the daemon re-checks the text for values, refuses a stale
 * approval, audits the change and closes the card. The generic agenda answer approves nothing, so this form is the
 * only answer drawn. A daemon that cannot be read draws the card's own words and says where else to answer.
 */

import { type AgendaItem, DAEMON_FEATURES } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineOffers } from '../../lib/daemon-health.ts';
import { type InputClient, readAccounts } from '../../lib/input-api.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import {
  RECIPE_APPROVED_WORDS,
  RECIPE_DECLINED_WORDS,
  classifyRecipeDecideFailure,
  recipeProposalView,
} from '../../lib/recipe-proposal-card.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { decideProposal } from '../accounts/accounts-api.ts';
import type { RulesBinding } from '../accounts/use-sign-in-rules.ts';
import { type RecipeCardPhase, RecipeProposalCard } from './recipe-proposal-card.tsx';

export interface RecipeProposalHostProps {
  readonly connection: DaemonConnection;
  readonly item: Pick<AgendaItem, 'recipeProposal'>;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  /** Says the machine offers `sign-in-rules.1` without reading its health (the harness and tests). */
  readonly offered?: boolean;
  readonly onDone?: () => void;
}

const settled = (phase: RecipeCardPhase): boolean => phase.kind === 'saving' || phase.kind === 'done';

export function RecipeProposalHost({
  connection,
  item,
  createClient: injected,
  offered: injectedOffered,
  onDone,
}: RecipeProposalHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const health = useDaemonHealth(injectedOffered === undefined ? connection : undefined);
  const withRules = injectedOffered ?? machineOffers(health, DAEMON_FEATURES.signInRules);
  // The semantic keys, not the ref object: an agenda snapshot parsed again carries an equal but new object.
  const signIn = item.recipeProposal?.signIn;
  const proposal = item.recipeProposal?.proposal;
  const router = useOptionalRouter();
  const [client, setClient] = useState<InputClient | null>(null);
  const [phase, setPhase] = useState<RecipeCardPhase>({ kind: 'checking' });
  const [reads, setReads] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** Counts the owner's decisions (and a change of proposal): a read begun before the latest one is out of date. */
  const generation = useRef(0);
  /** A decision is on its way: nothing else may start one, and no read may draw over it. */
  const inFlight = useRef(false);
  const seen = useRef<string | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` only re-runs the read when the owner presses Try again
  useEffect(() => {
    if (signIn === undefined || proposal === undefined) return undefined;
    const key = `${signIn}/${proposal}`;
    if (seen.current !== key) {
      // Another proposal: whatever was in flight for the last one is no longer this card's.
      seen.current = key;
      generation.current += 1;
      inFlight.current = false;
      setPhase({ kind: 'checking' });
    } else setPhase(prev => (settled(prev) ? prev : { kind: 'checking' }));
    const began = generation.current;
    let current = true;
    const fresh = (): boolean => current && generation.current === began;
    void createClient(connection)
      .then(async next => {
        if (!fresh()) return;
        setClient(next);
        const list = await readAccounts(next);
        if (fresh())
          setPhase(prev =>
            settled(prev) ? prev : { kind: 'open', view: recipeProposalView(list, { signIn, proposal }) },
          );
      })
      .catch(() => {
        if (fresh()) setPhase(prev => (settled(prev) ? prev : { kind: 'unread' }));
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, signIn, proposal, reads]);

  const decide = useCallback(
    async (decision: 'approve' | 'decline'): Promise<void> => {
      if (signIn === undefined || proposal === undefined || client === null) return;
      if (inFlight.current) return;
      const now = phaseRef.current;
      if (now.kind !== 'open' && now.kind !== 'failed') return;
      const { view } = now;
      if (view.kind === 'gone' || (decision === 'approve' && view.kind !== 'ready')) return;
      inFlight.current = true;
      generation.current += 1;
      const mine = generation.current;
      const mineStill = (): boolean => generation.current === mine;
      setPhase({ kind: 'saving', view, decision });
      try {
        await decideProposal(client, signIn, proposal, decision);
        if (!mineStill()) return;
        setPhase({
          kind: 'done',
          ok: decision === 'approve',
          words: decision === 'approve' ? RECIPE_APPROVED_WORDS : RECIPE_DECLINED_WORDS,
        });
        onDone?.();
      } catch (cause) {
        if (!mineStill()) return;
        const failure = classifyRecipeDecideFailure(cause);
        if (failure.kind === 'gone') {
          setPhase({ kind: 'done', ok: false, words: failure.words });
          return;
        }
        inFlight.current = false;
        // A stale approval: the recipe moved under the owner, so Approve goes and only Decline stays.
        const next = failure.kind === 'decline-only' ? { ...view, kind: 'stale' as const } : view;
        // A refusal this device cannot overcome takes both buttons; a transient failure keeps them for a retry.
        setPhase({ kind: 'failed', view: next, words: failure.words, refused: failure.kind === 'refused' });
      }
    },
    [client, onDone, proposal, signIn],
  );

  // Standing rules, read the way Settings reads them; a machine without the capability draws nothing.
  const rules = useMemo<RulesBinding | undefined>(
    () => (withRules && client !== null ? { client, askPasskey: undefined } : undefined),
    [client, withRules],
  );

  if (signIn === undefined) return null;
  return (
    <RecipeProposalCard
      onApprove={() => void decide('approve')}
      onDecline={() => void decide('decline')}
      onRetry={() => setReads(count => count + 1)}
      phase={phase}
      {...(rules === undefined ? {} : { rules })}
      {...(router === null
        ? {}
        : { settings: { href: `${daemonSettingsPath(connection.daemonId)}#accounts`, onOpen: router.navigate } })}
    />
  );
}
