/**
 * Fetches the approve-on-phone card an ask points at (`phone-approval`) from the daemon and keeps it fresh.
 * The card is read by its id from `/v1/phone-approvals`, never from the ask's text; a daemon that no longer lists the
 * approval draws nothing, and the ask is a plain notice.
 */

import type { PhoneApproval } from '../../../contract/routes/index.ts';
import { useEffect, useRef, useState } from 'react';
import { type AccountsClient, listPhoneApprovals, refusePhoneApproval } from '../accounts/accounts-api.ts';
import { isStepUpRefusal } from '../../lib/step-up-refusal.ts';
import { ConfirmToSee } from '../confirm-to-see.tsx';
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
  /** The daemon wants the owner's step-up to show this approval; the quiet read did not ask for it. */
  const [locked, setLocked] = useState(false);
  const [reads, setReads] = useState(0);
  /** Set by the owner's press on "Confirm it's you": the next read is theirs, so it may ask for the passkey. */
  const pressed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read when the owner confirms
  useEffect(() => {
    setFound(null);
    setLocked(false);
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (quiet: boolean): Promise<void> => {
      try {
        const { approvals } = await listPhoneApprovals(client, { quiet });
        const approval = approvals.find(each => each.id === approvalId && each.sessionId === ferret);
        if (!current) return;
        setLocked(false);
        setFound(approval ?? null);
        if (approval?.state === 'waiting') timer = setTimeout(() => void read(true), POLL_MS);
      } catch (cause) {
        if (!current) return;
        setFound(null);
        // The page's own read is quiet: a step-up the daemon wants waits for the owner's press, not for opening the chat.
        if (isStepUpRefusal(cause)) setLocked(true);
        else timer = setTimeout(() => void read(true), POLL_MS * 3);
      }
    };
    const owned = pressed.current;
    pressed.current = false;
    void read(!owned);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, approvalId, ferret, reads]);

  if (locked)
    return (
      <ConfirmToSee
        onConfirm={() => {
          pressed.current = true;
          setReads(count => count + 1);
        }}
      />
    );
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
