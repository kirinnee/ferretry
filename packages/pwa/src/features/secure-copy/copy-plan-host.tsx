/**
 * The paste plan a card points at (`copyPlan`), fetched: the plan is read from the daemon (`/v1/copy-plans`) by its
 * id, never from the card's text. A plan the daemon no longer holds (answered elsewhere, expired, or forgotten by a
 * restart) draws nothing; the card can still be closed.
 */

import type { AgendaItem, CopyPlan } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { answerPlan, type CopyClient, listPlans } from '../../lib/secure-copy.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { CopyPlanCard } from './copy-plan-card.tsx';

export interface CopyPlanHostProps {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly item: Pick<AgendaItem, 'copyPlan'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<CopyClient>;
  readonly onDone?: () => void;
}

export function CopyPlanHost({
  connection,
  sessionId,
  item,
  agentName,
  createClient: injected,
  onDone,
}: CopyPlanHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [found, setFound] = useState<{ readonly client: CopyClient; readonly plan: CopyPlan } | null>(null);

  useEffect(() => {
    let current = true;
    setFound(null);
    void createClient(connection)
      .then(async client => {
        const { plans } = await listPlans(client);
        const plan = plans.find(
          candidate => candidate.sessionId === sessionId && candidate.id === item.copyPlan?.planId,
        );
        if (current && plan !== undefined) setFound({ client, plan });
      })
      // A plan that cannot be read leaves the card as it is: approving is never the only way to answer it.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, createClient, sessionId, item.copyPlan?.planId]);

  if (found === null) return null;
  return (
    <CopyPlanCard
      agentName={agentName ?? 'The ferret'}
      onAnswer={async items => {
        const settled = await answerPlan(found.client, found.plan, items);
        onDone?.();
        return settled.state === 'declined'
          ? 'Declined: each paste will ask you.'
          : `Allowed ${String(settled.approved?.length ?? 0)} of ${String(settled.items.length)}, each once.`;
      }}
      plan={found.plan}
    />
  );
}
