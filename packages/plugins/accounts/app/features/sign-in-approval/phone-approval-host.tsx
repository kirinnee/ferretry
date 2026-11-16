/**
 * Fetches the approve-on-phone card an ask points at (`phone-approval`) from the daemon and keeps it fresh.
 * The card is read by its id from `/v1/phone-approvals`, never from the ask's text; a daemon that no longer lists the
 * approval draws nothing, and the ask is a plain notice.
 */

import type { PhoneApproval } from '../../../contract/routes/index.ts';
import { useEffect, useState } from 'react';
import { type AccountsClient, listPhoneApprovals, refusePhoneApproval } from '../accounts/accounts-api.ts';
import { PhoneApprovalCard } from './phone-approval-card.tsx';

const POLL_MS = 2_000;

export interface PhoneApprovalHostProps {
  readonly client: AccountsClient;
  readonly approvalId: string;
  /** The ferret the ask is about: an approval is read only when it is that ferret's. */
  readonly ferret: string;
  readonly onViewPage?: () => void;
  readonly onDone?: () => void;
}

export function PhoneApprovalHost({ client, approvalId, ferret, onViewPage, onDone }: PhoneApprovalHostProps) {
  const [found, setFound] = useState<PhoneApproval | null>(null);

  useEffect(() => {
    setFound(null);
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const { approvals } = await listPhoneApprovals(client);
        const approval = approvals.find(each => each.id === approvalId && each.sessionId === ferret);
        if (!current) return;
        setFound(approval ?? null);
        if (approval?.state === 'waiting') timer = setTimeout(() => void read(), POLL_MS);
      } catch {
        if (!current) return;
        setFound(null);
        timer = setTimeout(() => void read(), POLL_MS * 3);
      }
    };
    void read();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, approvalId, ferret]);

  if (found === null) return null;
  return (
    <PhoneApprovalCard
      approval={found}
      onRefuse={async () => {
        await refusePhoneApproval(client, found);
        setFound({ ...found, state: 'refused' });
        onDone?.();
      }}
      {...(onViewPage === undefined ? {} : { onViewPage })}
    />
  );
}
