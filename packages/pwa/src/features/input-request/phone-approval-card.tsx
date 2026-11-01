/**
 * The approve-on-phone card (docs/input-requests.md, "Approve on your phone"): a number to tap or type on the
 * owner's phone, drawn only from an approval the DAEMON raised. Every word is `phoneApprovalWords`' and every
 * digit is the daemon's reading of a provider's own page: nothing here accepts text or a number from a ferret.
 * The one control is "Not me — stop"; a sign-in settles only when the daemon sees it move on.
 */

import { Smartphone, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { PhoneApproval } from '@ferretry/protocol';
import {
  PHONE_APPROVAL_REFUSE_WORDS,
  PHONE_APPROVAL_VIEW_PAGE_WORDS,
  phoneApprovalCardModel,
} from '../../lib/phone-approval-card.ts';

export interface PhoneApprovalCardProps {
  readonly approval: PhoneApproval;
  /** Sends "Not me — stop". Rejects with why. */
  readonly onRefuse: () => Promise<void>;
  /** Shows the page the approval waits on; absent where the app cannot (the link is then not drawn). */
  readonly onViewPage?: () => void;
}

export function PhoneApprovalCard({ approval, onRefuse, onViewPage }: PhoneApprovalCardProps) {
  const model = phoneApprovalCardModel(approval);
  const { words } = model;
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refuse = async (): Promise<void> => {
    setSending(true);
    setFailure(null);
    try {
      await onRefuse();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-phone-approval={approval.id}
      data-phone-approval-state={approval.state}
    >
      <div className="flex items-center gap-2 text-ui font-medium text-fg" data-phone-approval-title="">
        <Smartphone size={16} aria-hidden="true" />
        {words.title}
      </div>
      <p className="m-0 min-w-0 break-words text-ui text-fg" data-phone-approval-who="">
        {words.who}
      </p>
      <p className="m-0 min-w-0 break-words text-cell text-muted" data-phone-approval-where="">
        {words.where}
      </p>
      {model.number === undefined ? null : (
        <div className="flex flex-col gap-1 rounded-control border border-border bg-surface-2 p-4 text-center">
          <span
            aria-label={`Number ${model.number}`}
            role="img"
            className="mono text-[56px] font-semibold leading-none tracking-wider text-fg"
            data-phone-approval-number=""
          >
            {model.number}
          </span>
          <span className="text-ui text-fg" data-phone-approval-direction="">
            {words.numberLine}
          </span>
          {words.numberSource === undefined ? null : (
            <span className="text-meta text-faint" data-phone-approval-source="">
              {words.numberSource}
            </span>
          )}
        </div>
      )}
      {model.number !== undefined || words.noNumber === undefined ? null : (
        <div
          className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
          data-phone-approval-no-number={model.terminal ? 'terminal' : model.steered ? 'steered' : 'page'}
        >
          <p className="m-0 text-ui text-fg">{words.noNumber}</p>
          {model.canViewPage && onViewPage !== undefined ? (
            <button
              className="kt-btn min-h-[44px] self-start"
              data-phone-approval-view=""
              onClick={onViewPage}
              type="button"
            >
              {PHONE_APPROVAL_VIEW_PAGE_WORDS}
            </button>
          ) : null}
        </div>
      )}
      <p className="m-0 flex items-start gap-1.5 text-meta font-medium text-warn" data-phone-approval-warning="">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        {words.warning}
      </p>
      {model.settled === undefined ? null : (
        <p className="m-0 text-ui text-muted" data-phone-approval-settled="" role="status">
          {model.settled}
        </p>
      )}
      {failure === null ? null : (
        <p className="m-0 text-ui text-err" data-phone-approval-failure="" role="alert">
          {failure}
        </p>
      )}
      {model.canRefuse ? (
        <div className="flex justify-end">
          <button
            className="kt-btn min-h-[44px]"
            data-phone-approval-refuse=""
            disabled={sending}
            onClick={() => void refuse()}
            type="button"
          >
            {sending ? 'Stopping…' : PHONE_APPROVAL_REFUSE_WORDS}
          </button>
        </div>
      ) : null}
    </div>
  );
}
