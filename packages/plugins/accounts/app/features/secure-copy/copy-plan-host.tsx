/**
 * The paste plan an ask points at (`copy-plan`), fetched: the plan is read from the daemon (`/v1/copy-plans`) by its
 * id, never from the ask's text. A plan the daemon no longer holds (answered elsewhere, expired, or forgotten by a
 * restart) draws nothing; the ask can still be closed.
 */

import type { CopyPlan } from '../../../contract/routes/index.ts';
import { useEffect, useState } from 'react';
import { answerPlan, type CopyClient, listPlans } from '../../lib/secure-copy.ts';
import { CopyPlanCard } from './copy-plan-card.tsx';

export interface CopyPlanHostProps {
  readonly client: CopyClient;
  /** The ferret the ask is about (a plan belongs to one ferret). */
  readonly ferret: string;
  readonly planId: string;
  readonly agentName?: string;
  readonly onDone?: () => void;
}

export function CopyPlanHost({ client, ferret, planId, agentName, onDone }: CopyPlanHostProps) {
  const [found, setFound] = useState<CopyPlan | null>(null);

  useEffect(() => {
    let current = true;
    setFound(null);
    void listPlans(client)
      .then(({ plans }) => {
        const plan = plans.find(candidate => candidate.sessionId === ferret && candidate.id === planId);
        if (current && plan !== undefined) setFound(plan);
      })
      // A plan that cannot be read leaves the card as it is: approving is never the only way to answer it.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, ferret, planId]);

  if (found === null) return null;
  return (
    <CopyPlanCard
      agentName={agentName ?? 'The ferret'}
      onAnswer={async items => {
        const settled = await answerPlan(client, found, items);
        onDone?.();
        return settled.state === 'declined'
          ? 'Declined: each paste will ask you.'
          : `Allowed ${String(settled.approved?.length ?? 0)} of ${String(settled.items.length)}, each once.`;
      }}
      plan={found}
    />
  );
}
