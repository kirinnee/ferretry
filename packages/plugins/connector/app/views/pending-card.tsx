/**
 * ONE SIGN-IN WAITING FOR THE OWNER: who asks, what they would be allowed, the MATCH CODE, and Approve / Deny.
 *
 * The code is drawn large and the warning that goes with it sits in the same breath, never behind a disclosure: the
 * code is the phishing defence (a passkey belongs to THIS app's origin, not to the tunnel hostname that serves /mcp).
 * The card holds public ids, a code, names and times; never a handle, an authorization code or a token.
 */
import { Fingerprint, X } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@ferretry/app/ui';
import type { ConnectorPendingView } from '../../contract/index.ts';
import { agoWords, MATCH_CODE_WARNING, scopeSentence } from '../lib/words.ts';

export function PendingCard({
  pending,
  now,
  busy,
  focused,
  canApprove,
  onApprove,
  onDeny,
}: {
  readonly pending: ConnectorPendingView;
  readonly now: number;
  /** An act is running (on this card or another): nothing else may be pressed. */
  readonly busy: boolean;
  /** The waiting page's link named this one (`?request=`). */
  readonly focused: boolean;
  /** This device may approve (a grant that forbids it hides the button; the daemon's own word is the final one). */
  readonly canApprove: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}) {
  const warningId = useId();
  return (
    <li
      data-connector-pending={pending.id}
      data-focused={focused || undefined}
      className="flex min-w-0 flex-col gap-2 px-panel py-3"
    >
      <p className="m-0 break-words text-ui font-semibold text-fg" data-connector-headline="">
        {pending.clientName} wants to {scopeSentence(pending.scopes)}
      </p>
      <p className="m-0 text-meta leading-base text-faint">
        From {pending.redirectHost} · asked {agoWords(pending.createdAt, now)}
      </p>
      <p
        data-connector-match-code=""
        className="m-0 w-fit max-w-full select-all rounded-panel border border-border-strong bg-surface-2 px-[max(1rem,var(--radius-panel))] py-3 font-mono text-[2rem] font-bold leading-none tracking-[0.18em] text-fg"
      >
        {pending.matchCode}
      </p>
      <p id={warningId} data-connector-warning="" className="m-0 text-cell leading-base text-warn">
        {MATCH_CODE_WARNING}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {canApprove ? (
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-describedby={warningId}
            data-connector-approve={pending.id}
            icon={<Fingerprint size={15} aria-hidden="true" />}
            onClick={onApprove}
            className="min-h-[44px]"
          >
            Approve with passkey
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={busy}
          data-connector-deny={pending.id}
          icon={<X size={15} aria-hidden="true" />}
          onClick={onDeny}
          className="min-h-[44px]"
        >
          Deny
        </Button>
      </div>
    </li>
  );
}
