/**
 * THE TWO PIECES THE CHAT PAGE DRAWS ITSELF. Ported from `PendingMessage` and `ThreadSkeleton` in kteam
 * `ui/src/pages/SessionChatPage.tsx`; the third, the attachment strip, is the composer's
 * (`composer/pending-attachments.tsx`), which owns the files it is about to send.
 *
 * THE PENDING BUBBLE never claims more than is known. Its wording, and why it stops where it does, is
 * `PENDING_BADGE` in `session-chat-model.ts` — read that comment before changing a label here.
 *
 * NOT PORTED, and taken as a render prop rather than faked: kteam's `TranscriptImageGallery` (from
 * `AttachmentImage.tsx`) has no Ferretry equivalent yet, so the pending bubble asks its host to draw the images.
 */

import type { ReactNode } from 'react';
import type { StoredTranscriptAttachment } from '../composer/attachments.ts';
import { cn } from '@ferretry/app/ui';
import { PENDING_BADGE, type PendingStatus } from './session-chat-model.ts';

export interface PendingMessageProps {
  readonly text: string;
  readonly attachments: readonly StoredTranscriptAttachment[];
  readonly status: PendingStatus;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
  /** Draws the attached images — see the file header for why it is injected. */
  readonly renderAttachments?: (images: readonly StoredTranscriptAttachment[]) => ReactNode;
}

/**
 * The optimistic "sent" bubble. It mirrors the human styling with a
 * pending → queued/accepted/failed chip so a send never feels lost.
 *
 * The status used to be a bare run of coloured monospace hard against the box's
 * right edge, which read as a glitch rather than a label. It is now the same
 * quiet chip the rest of the UI uses, and the four states are the same width, so
 * the pending → accepted transition cannot jump the layout.
 */
export function PendingMessage({
  attachments,
  onDismiss,
  onRetry,
  renderAttachments,
  status,
  text,
}: PendingMessageProps) {
  const { label, tone } = PENDING_BADGE[status];
  return (
    <div className="kt-bubble-row">
      <span className="sr-only">You said:</span>
      <div className="kt-bubble">
        <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
          <span
            className={cn(
              'ml-auto inline-flex shrink-0 select-none items-center gap-1 rounded-sm border px-1.5 py-px font-medium text-[10.5px] leading-[1.5]',
              tone,
            )}
          >
            {status === 'sending' ? (
              <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
            ) : null}
            {label}
          </span>
          {status === 'error' ? (
            <>
              {/* Retry re-uses this message's original request id, so a first
                  attempt that DID land is recognised by the daemon and dropped
                  rather than delivered twice. */}
              <button
                className="shrink-0 rounded-sm border border-border px-1.5 py-px font-medium text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg"
                onClick={onRetry}
                title="Send this message again with the same idempotency key — if the first attempt actually landed, the daemon will not deliver it twice"
                type="button"
              >
                retry
              </button>
              <button
                className="shrink-0 rounded-sm px-1 py-px text-[10.5px] text-muted hover:text-fg"
                onClick={onDismiss}
                title="Remove this box"
                type="button"
              >
                dismiss
              </button>
            </>
          ) : null}
        </div>
        {text ? (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pt-0.5 pb-1.5 text-[13px] text-[color:var(--bubble-fg)] leading-snug">
            {text}
          </div>
        ) : null}
        {renderAttachments?.(attachments)}
      </div>
    </div>
  );
}

/** The placeholder shown while a session's first history page is in flight. */
export function ThreadSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading the conversation"
      className="mx-auto flex h-full w-full max-w-[880px] flex-col gap-3 p-3"
      role="status"
    >
      {['a', 'b', 'c', 'd', 'e', 'f'].map(slot => (
        <div className="animate-pulse space-y-2" key={slot}>
          <div className="h-2.5 w-24 rounded bg-surface-2" />
          <div className="h-3 w-4/5 rounded bg-surface-2" />
          <div className="h-3 w-3/5 rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
