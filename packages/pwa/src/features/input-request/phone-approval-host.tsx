/**
 * Fetches the approve-on-phone card an agenda item points at (`phoneApproval`) from the daemon and keeps it fresh.
 * The card is read by its id from `/v1/phone-approvals`, never from the item's text; a daemon that does not report
 * `input.phone-approval.1`, or no longer lists the approval, draws nothing, and the item is a plain info card.
 */

import { DAEMON_FEATURES, type PhoneApproval } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineOffers } from '../../lib/daemon-health.ts';
import { type InputClient, listPhoneApprovals, refusePhoneApproval } from '../../lib/input-api.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { PhoneApprovalCard } from './phone-approval-card.tsx';

const POLL_MS = 2_000;

export interface PhoneApprovalHostProps {
  readonly connection: DaemonConnection;
  readonly approvalId: string;
  readonly sessionId: string;
  readonly onViewPage?: () => void;
  readonly onDone?: () => void;
}

export function PhoneApprovalHost({ connection, approvalId, sessionId, onViewPage, onDone }: PhoneApprovalHostProps) {
  const createClient = useDaemonClient();
  const health = useDaemonHealth(connection);
  const offered = machineOffers(health, DAEMON_FEATURES.phoneApproval);
  const [found, setFound] = useState<{ readonly client: InputClient; readonly approval: PhoneApproval } | null>(null);

  useEffect(() => {
    if (!offered) return undefined;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (client: InputClient): Promise<void> => {
      try {
        const { approvals } = await listPhoneApprovals(client);
        const approval = approvals.find(each => each.id === approvalId && each.sessionId === sessionId);
        if (!current) return;
        setFound(approval === undefined ? null : { client, approval });
        if (approval?.state === 'waiting') timer = setTimeout(() => void read(client), POLL_MS);
      } catch {
        if (current) timer = setTimeout(() => void read(client), POLL_MS * 3);
      }
    };
    void createClient(connection)
      .then(client => (current ? read(client) : undefined))
      .catch(() => undefined);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [offered, connection, createClient, approvalId, sessionId]);

  if (!offered || found === null) return null;
  return (
    <PhoneApprovalCard
      approval={found.approval}
      onRefuse={async () => {
        await refusePhoneApproval(found.client, found.approval);
        setFound({ client: found.client, approval: { ...found.approval, state: 'refused' } });
        onDone?.();
      }}
      {...(onViewPage === undefined ? {} : { onViewPage })}
    />
  );
}
