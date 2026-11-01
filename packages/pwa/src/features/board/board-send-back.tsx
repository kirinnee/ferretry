/**
 * SENDING A CARD BACK, WITH WORDS AND PICTURES: the composer behind "Not good", "Reopen" and every other move back
 * the owner makes on the Board (`board-design.md` §2.9). The words are the reason the ferret reads; the files go
 * with them, as a chat's would.
 *
 * The files are the chat composer's own: `useComposerAttachments` uploads each the moment it is added (paste a
 * screenshot, or Attach), with the same type and size checks, and `PendingAttachmentStrip` draws them. They go
 * to the card's ferret's session, because that is where the daemon looks for them; the move then names them.
 *
 * THE APP SHIPS BEFORE THE DAEMON. Attach is offered only once the machine has said it takes files with a move
 * back (`board.reopen.attachments.1`). A machine that has not answered yet shows Attach waiting; one that said no
 * gets the words alone, and a line saying an update brings the pictures.
 */

import { type AttachmentView, MAX_BOARD_REASON_LENGTH, MAX_BOARD_REOPEN_ATTACHMENTS } from '@ferretry/protocol';
import { Paperclip, Send } from 'lucide-react';
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type ComposerAttachmentUploader, useComposerAttachments } from '../../components/composer-attachments.ts';
import { PendingAttachmentStrip } from '../../components/session-chat-parts.tsx';
import { Spinner } from '../../components/spinner.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { UPDATE_MACHINE_WHERE } from '../../lib/machine-update-words.ts';

/** What the Board needs from a machine to send files with a move back. */
export interface SendBackPorts {
  /** Whether the machine takes files with a move back (`board.reopen.attachments.1` on its health). */
  readonly sendBackFiles?: (daemon: DaemonConnection) => Promise<boolean>;
  /** Uploads one file to a ferret's session on the machine. */
  readonly uploadAttachment?: (daemon: DaemonConnection, sessionId: string, file: File) => Promise<AttachmentView>;
}

/** Files on a move back, as the composer sees them for one card. */
export interface SendBackFiles {
  /** `true` the machine takes them, `false` it is too old, `null` it has not answered. */
  readonly offered: boolean | null;
  readonly upload: ComposerAttachmentUploader;
  /** The session they are uploaded to: the card's ferret. */
  readonly sessionId: string;
}

/** What the composer hands back: the words, and the ids of the files the machine now holds. */
export interface SendBack {
  readonly reason: string;
  readonly attachmentIds: readonly string[];
}

/** What the owner reads where the machine is too old to take pictures with a move back. */
export const SEND_BACK_FILES_NEED_UPDATE = `This machine needs an update to send pictures with it: ${UPDATE_MACHINE_WHERE}.`;

/**
 * Asks the card's machine whether it takes files, and uploads to the card's ferret. `null` when the page has no
 * way to upload at all (no ports), which draws the words alone and says nothing about updates.
 */
export function useSendBackFiles(
  ports: SendBackPorts | undefined,
  daemon: DaemonConnection | undefined,
  sessionId: string | null,
): SendBackFiles | null {
  const asks = ports?.sendBackFiles;
  const upload = ports?.uploadAttachment;
  const [offered, setOffered] = useState<{ readonly daemonId: string; readonly offered: boolean } | null>(null);
  const daemonId = daemon?.daemonId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the machine's id is the re-ask trigger, not its object
  useEffect(() => {
    if (asks === undefined || daemon === undefined || daemonId === undefined) return undefined;
    let live = true;
    void asks(daemon).then(
      answer => {
        if (live) setOffered({ daemonId, offered: answer });
      },
      () => {
        // A machine that cannot be asked is treated like one not yet read: no files, and no update nag.
        if (live) setOffered(null);
      },
    );
    return () => {
      live = false;
    };
  }, [asks, daemonId]);
  return useMemo(() => {
    if (asks === undefined || upload === undefined || daemon === undefined || sessionId === null) return null;
    return {
      offered: offered?.daemonId === daemon.daemonId ? offered.offered : null,
      upload: file => upload(daemon, sessionId, file),
      sessionId,
    };
  }, [asks, upload, daemon, sessionId, offered]);
}

export interface BoardSendBackProps {
  /** What is being sent back, e.g. `Not good: send Pairing QR back to Implement`. */
  readonly heading: string;
  readonly busy: boolean;
  /** The last refusal, or `null`. */
  readonly error: string | null;
  readonly onSubmit: (sendBack: SendBack) => void;
  readonly onCancel: () => void;
  /** Files for this card's ferret; `null` draws the words alone. */
  readonly files: SendBackFiles | null;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  /** The words may be left empty: the answer goes without them (a "Not yet"). */
  readonly wordsOptional?: boolean;
  readonly busyLabel?: string;
}

export function BoardSendBack({
  heading,
  busy,
  error,
  onSubmit,
  onCancel,
  files,
  placeholder = 'What is not good? The ferret reads this.',
  submitLabel = 'Send back',
  busyLabel = 'Sending…',
  wordsOptional = false,
}: BoardSendBackProps) {
  const [reason, setReason] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const errorId = useId();
  const attachable = files !== null && files.offered === true;
  const attachments = useComposerAttachments(attachable ? files.upload : undefined, files?.sessionId ?? '');
  useEffect(() => input.current?.focus(), []);

  const trimmed = reason.trim();
  const full = attachments.entries.length >= MAX_BOARD_REOPEN_ATTACHMENTS;
  const hold = attachments.uploading
    ? 'Wait for the files to finish uploading.'
    : attachments.failed.length > 0
      ? 'Remove or retry the file that did not upload.'
      : null;
  const canSend = (trimmed !== '' || wordsOptional) && !busy && hold === null;

  const add = (picked: readonly File[]): void => {
    if (!attachable || picked.length === 0) return;
    attachments.add(picked.slice(0, Math.max(0, MAX_BOARD_REOPEN_ATTACHMENTS - attachments.entries.length)));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (canSend) onSubmit({ reason: trimmed, attachmentIds: attachments.readyIds });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    // Enter alone sends, as the box it replaced did; Shift+Enter is a new line.
    if (event.key === 'Enter' && !event.shiftKey && event.target === input.current) {
      event.preventDefault();
      if (canSend) onSubmit({ reason: trimmed, attachmentIds: attachments.readyIds });
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (!attachable || pasted.length === 0) return;
    event.preventDefault();
    add(pasted);
  };

  return (
    <form
      aria-busy={busy}
      aria-labelledby={headingId}
      aria-modal="true"
      className="fy-board-reason fy-board-sendback"
      data-board-send-back=""
      onKeyDown={onKeyDown}
      onSubmit={submit}
      role="dialog"
    >
      <p className="fy-board-reason__heading" id={headingId}>
        {heading}
      </p>
      <textarea
        aria-describedby={error === null ? undefined : errorId}
        aria-invalid={error !== null}
        aria-label="Reason"
        className="fy-board-reason__input fy-board-sendback__input"
        disabled={busy}
        maxLength={MAX_BOARD_REASON_LENGTH}
        onChange={event => setReason(event.target.value)}
        onPaste={onPaste}
        placeholder={placeholder}
        ref={input}
        required={!wordsOptional}
        rows={3}
        value={reason}
      />
      {attachments.entries.length === 0 ? null : (
        <PendingAttachmentStrip
          entries={attachments.entries}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
        />
      )}
      {files !== null && files.offered === false ? (
        <p className="fy-board-sendback__note" data-send-back-note="update">
          {SEND_BACK_FILES_NEED_UPDATE}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="fy-board-reason__error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="fy-board-reason__actions fy-board-sendback__actions">
        {files === null || files.offered === false ? null : (
          <>
            <button
              className="kt-btn fy-board-sendback__attach"
              data-variant="ghost"
              disabled={!attachable || busy || full}
              onClick={() => picker.current?.click()}
              title={
                files.offered === null
                  ? 'Asking the machine whether it takes files…'
                  : full
                    ? `Up to ${MAX_BOARD_REOPEN_ATTACHMENTS} files`
                    : 'Attach images or files'
              }
              type="button"
            >
              <Paperclip aria-hidden="true" size={14} />
              Attach
            </button>
            <input
              aria-hidden="true"
              className="hidden"
              data-send-back-picker=""
              multiple
              onChange={event => {
                add(Array.from(event.currentTarget.files ?? []));
                // Cleared so choosing the same file again is still a change.
                event.currentTarget.value = '';
              }}
              ref={picker}
              tabIndex={-1}
              type="file"
            />
          </>
        )}
        {hold === null || attachments.entries.length === 0 ? null : (
          <span className="fy-board-sendback__hold" role="status">
            {hold}
          </span>
        )}
        <span className="fy-board-sendback__spacer" />
        <button className="kt-btn" data-variant="ghost" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          aria-label={busy ? busyLabel : submitLabel}
          className="kt-btn fy-board-sendback__send"
          data-variant="primary"
          disabled={!canSend}
          type="submit"
        >
          {busy ? <Spinner className="fy-board-answer-spinner" size={14} /> : <Send aria-hidden="true" size={14} />}
          {/* Both words take the same room, so the button does not change width while it sends. */}
          <span className="fy-board-sendback__send-label" data-busy={busy ? '' : undefined}>
            <span aria-hidden={busy}>{submitLabel}</span>
            <span aria-hidden={!busy}>{busyLabel}</span>
          </span>
        </button>
      </div>
    </form>
  );
}
