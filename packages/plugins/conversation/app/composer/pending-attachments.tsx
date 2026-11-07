/**
 * THE COMPOSER'S PENDING FILES, drawn: the chips under the box while a file uploads, is ready, failed, or waits for
 * the connection. Moved here from today's `session-chat-model.ts` (`PendingAttachment`) and `session-chat-parts.tsx`
 * (`PendingAttachmentStrip`): the composer owns the files it is about to send, and the chat imports them from here.
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
 */

import { cn } from '@ferretry/app/ui';
import { FileText, ImageOff, Loader2, LockKeyhole, LockKeyholeOpen, RotateCcw, X } from 'lucide-react';
import {
  type AttachmentView,
  attachmentLockCopy,
  attachmentTypeLabel,
  formatAttachmentSize,
  isAttachmentEncryption,
  isBrowserOpenableAttachment,
  isImageMime,
  textExtractionFailureCopy,
} from './attachments.ts';

/**
 * `deferred`: the connection is gone, so the file is not uploaded now — it goes to this device's outbox with the
 * message and is uploaded there, before the send, once the machine answers again.
 */
export type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed' | 'deferred';

export interface PendingAttachment {
  readonly localId: string;
  readonly file: File;
  readonly objectUrl?: string;
  readonly status: PendingAttachmentStatus;
  readonly view?: AttachmentView;
  readonly error?: string;
  /** What an upload that has not finished is doing instead — waiting its turn, or retrying a drop. */
  readonly note?: string;
  /**
   * The file's size when `file` does not hold its bytes: a file another of the owner's devices attached,
   * which this one only names.
   */
  readonly size?: number;
  /** `false` for a placeholder this device cannot remove: another device's upload still on its way. */
  readonly removable?: false;
}

export interface PendingAttachmentStripProps {
  readonly entries: readonly PendingAttachment[];
  readonly onRetry: (entry: PendingAttachment) => void;
  /** Open the chip's file: a picture full screen, a document in its own tab. Not given, a chip is static. */
  readonly onOpen?: (entry: PendingAttachment) => void;
  readonly onRemove: (entry: PendingAttachment) => void;
  /** Optional so the strip still renders where no unlock flow is wired. */
  readonly onUnlock?: (entry: PendingAttachment) => void;
  readonly onForget?: (entry: PendingAttachment) => void;
}

export function PendingAttachmentStrip({
  entries,
  onForget,
  onOpen,
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
        const openable = onOpen !== undefined && (entry.objectUrl !== undefined || isBrowserOpenableAttachment(mime));
        const body = (
          <>
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
              ) : entry.status === 'deferred' ? (
                <span className="block text-muted">{entry.note}</span>
              ) : (
                <span className="flex min-w-0 items-center gap-1">
                  {/* Another device's upload in progress: its size is not known here yet. */}
                  {entry.removable === false ? null : (
                    <>
                      <span className="shrink-0 text-faint">{formatAttachmentSize(entry.size ?? entry.file.size)}</span>
                      <span aria-hidden="true" className="shrink-0 text-faint">
                        ·
                      </span>
                    </>
                  )}
                  {entry.status === 'uploading' ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-muted">
                      <Loader2
                        aria-hidden="true"
                        className="shrink-0 animate-spin motion-reduce:animate-none"
                        size={11}
                      />{' '}
                      <span className="truncate">{entry.note ?? 'uploading'}</span>
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
          </>
        );
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
            {openable ? (
              <button
                aria-label={`Open ${entry.file.name}`}
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => onOpen?.(entry)}
                title={entry.objectUrl ? 'View full screen' : 'Open in a new tab'}
                type="button"
              >
                {body}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">{body}</div>
            )}
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
            {entry.status === 'failed' || entry.status === 'deferred' ? (
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
            {entry.removable === false ? null : (
              <button
                aria-label={`Remove ${entry.file.name}`}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
                onClick={() => onRemove(entry)}
                title="Remove file"
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
