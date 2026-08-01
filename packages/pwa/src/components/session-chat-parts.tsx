/**
 * THE THREE PIECES THE CHAT PAGE DRAWS ITSELF. Ported from
 * `PendingAttachmentStrip`, `PendingMessage` and `ThreadSkeleton` in kteam
 * `ui/src/pages/SessionChatPage.tsx`.
 *
 * Everything else on that page is a component this repo already has — the
 * transcript, the composer, the question form, the session header, the side pane.
 * These three had no home outside the page, so they arrive here, next to the
 * model that decides what they say.
 *
 * THE PENDING BUBBLE never claims more than is known. Its wording, and why it
 * stops where it does, is `PENDING_BADGE` in `session-chat-model.ts` — read that
 * comment before changing a label here.
 *
 * THE ATTACHMENT STRIP is two rows at tight leading, not three at body leading.
 * It used to put 60px of type beside a 44px button and cost 74px of height before
 * a pixel of it said anything the reader did not already know. Size and state now
 * share row two — both are one short token, they are read together ("472 KB ·
 * ready"), and the state keeps its own colour so the scan still works. FAILURE IS
 * THE DELIBERATE EXCEPTION: an error is a sentence, not a token, so on `failed`
 * the size is dropped and the error takes the whole second row so it can wrap
 * instead of truncate. That chip is also the only one needing a SECOND 44px
 * control, which is why it alone gets the wider box.
 *
 * A locked attachment is a state the reader can RESOLVE, so it is never rendered
 * with the terminal extraction-failure copy — it gets its own action instead.
 *
 * NOT PORTED, and taken as a render prop rather than faked: kteam's
 * `TranscriptImageGallery` (from `AttachmentImage.tsx`) has no Ferretry
 * equivalent yet, so the pending bubble asks its host to draw the images.
 */

import { FileText, ImageOff, Loader2, LockKeyhole, LockKeyholeOpen, RotateCcw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  attachmentLockCopy,
  attachmentTypeLabel,
  formatAttachmentSize,
  isAttachmentEncryption,
  isImageMime,
  type StoredTranscriptImage,
  textExtractionFailureCopy,
} from '../lib/attachments.ts';
import { cn } from '../lib/class-names.ts';
import { PENDING_BADGE, type PendingAttachment, type PendingStatus } from './session-chat-model.ts';

export interface PendingAttachmentStripProps {
  readonly entries: readonly PendingAttachment[];
  readonly onRetry: (entry: PendingAttachment) => void;
  readonly onRemove: (entry: PendingAttachment) => void;
  /** Optional so the strip still renders where no unlock flow is wired. */
  readonly onUnlock?: (entry: PendingAttachment) => void;
  readonly onForget?: (entry: PendingAttachment) => void;
}

export function PendingAttachmentStrip({
  entries,
  onForget,
  onRemove,
  onRetry,
  onUnlock,
}: PendingAttachmentStripProps) {
  // Alignment is the flex default `stretch`, deliberately NOT `items-start`: the
  // failed chip is the tallest and already sets the strip's height, so letting the
  // others match it costs no pixels and keeps the row from reading as ragged.
  //
  // A real `<ul>`, because a labelled list is what this is: `aria-label` on a bare
  // div carries no role, and a `role="list"` would only ask for the element the
  // markup should have used in the first place.
  return (
    <ul
      aria-label="Attached files"
      className="flex min-w-0 list-none gap-1.5 scroll-thin overflow-x-auto border-border-soft border-b p-0 pb-1"
    >
      {entries.map(entry => {
        const encryption = isAttachmentEncryption(entry.view?.encrypted) ? entry.view.encrypted : undefined;
        const mime = entry.view?.mime ?? entry.file.type;
        return (
          <li
            className={cn(
              'flex items-center gap-1.5 rounded-control border bg-surface-2 p-1',
              entry.status === 'failed'
                ? 'min-w-[252px] max-w-[320px] border-err-border'
                : 'min-w-[230px] max-w-[320px] border-border-soft',
            )}
            key={entry.localId}
            role={entry.status === 'failed' ? 'alert' : 'status'}
          >
            {entry.objectUrl ? (
              <img
                alt=""
                className="h-9 w-9 shrink-0 rounded-sm border border-border-soft object-cover"
                src={entry.objectUrl}
              />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-border-soft bg-surface">
                {isImageMime(mime) ? (
                  <ImageOff aria-hidden="true" className="text-muted" size={16} />
                ) : (
                  <FileText aria-hidden="true" className="text-muted" size={16} />
                )}
              </span>
            )}
            <span className="min-w-0 flex-1 text-meta leading-tight">
              <span className="block truncate text-fg" title={entry.file.name}>
                {entry.file.name}
              </span>
              {entry.status === 'failed' ? (
                <span className="block text-err">{entry.error}</span>
              ) : (
                <span className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0 text-faint">{formatAttachmentSize(entry.file.size)}</span>
                  <span aria-hidden="true" className="shrink-0 text-faint">
                    ·
                  </span>
                  {entry.status === 'uploading' ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-muted">
                      <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={11} />{' '}
                      uploading
                    </span>
                  ) : (
                    <span className="shrink-0 text-ok">ready</span>
                  )}
                </span>
              )}
              {isImageMime(mime) ? null : (
                <span className="block truncate text-faint">{attachmentTypeLabel(mime)}</span>
              )}
              {entry.view?.textExtraction ? (
                <span className="block text-faint">
                  text extracted for agent{entry.view.textExtraction.truncated ? ' · truncated' : ''}
                </span>
              ) : null}
              {entry.status === 'ready' && entry.view?.textExtractionFailure ? (
                <span className="block text-warn">
                  {textExtractionFailureCopy(entry.view.textExtractionFailure.code)}
                </span>
              ) : null}
              {entry.status === 'ready' && encryption ? (
                <span className={cn('block', encryption.locked ? 'text-warn' : 'text-ok')}>
                  {attachmentLockCopy(encryption)}
                </span>
              ) : null}
            </span>
            {entry.status === 'ready' && encryption?.locked && onUnlock ? (
              <button
                aria-label={`Unlock ${entry.file.name}`}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-warn hover:bg-surface hover:text-fg"
                onClick={() => onUnlock(entry)}
                title="Enter the PDF password"
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={15} />
              </button>
            ) : null}
            {entry.status === 'ready' && encryption && !encryption.locked && onForget ? (
              <button
                aria-label={`Forget the decrypted copy of ${entry.file.name}`}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-ok hover:bg-surface hover:text-fg"
                onClick={() => onForget(entry)}
                title="Forget the decrypted copy"
                type="button"
              >
                <LockKeyholeOpen aria-hidden="true" size={15} />
              </button>
            ) : null}
            {entry.status === 'failed' ? (
              <button
                aria-label={`Retry ${entry.file.name}`}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
                onClick={() => onRetry(entry)}
                title="Retry upload"
                type="button"
              >
                <RotateCcw aria-hidden="true" size={15} />
              </button>
            ) : null}
            <button
              aria-label={`Remove ${entry.file.name}`}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
              onClick={() => onRemove(entry)}
              title="Remove file"
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface PendingMessageProps {
  readonly text: string;
  readonly attachments: readonly StoredTranscriptImage[];
  readonly status: PendingStatus;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
  /** Draws the attached images — see the file header for why it is injected. */
  readonly renderAttachments?: (images: readonly StoredTranscriptImage[]) => ReactNode;
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
