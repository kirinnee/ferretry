/**
 * SENDING A CARD BACK, WITH WORDS AND PICTURES: the box behind "Not good", "Reopen" and every other move back
 * the owner makes — on the Board, in a to-test row and in the Inbox deck (`board-design.md` §2.9). The words are
 * the reason the ferret reads; the files go with them, as a chat's would.
 *
 * THE BOX IS THE CHAT'S OWN COMPOSER, detached from any chat (`Composer`'s `detached` mode): the same editing
 * surface, voice, Enter and Shift+Enter, paste and drop, and none of what belongs to a conversation — its words
 * are the host's move and are kept nowhere, so a Not good typed here is never the ferret's chat draft and never
 * queued as a message. Every place a send-back is asked for draws this one component, so its width is one rule.
 *
 * The files are the composer's own: each is uploaded the moment it is added, with the same type and size checks,
 * to the card's ferret's session, because that is where the daemon looks for them; the move then names them.
 *
 * THE APP SHIPS BEFORE THE DAEMON. Attach is offered only once the machine has said it takes files with a move
 * back (`board.reopen.attachments.1`). A machine that has not answered yet, or has no way to upload, draws the
 * words alone; one that said no also says an update brings the pictures.
 */

import { type AttachmentView, MAX_BOARD_REASON_LENGTH, MAX_BOARD_REOPEN_ATTACHMENTS } from '@ferretry/protocol';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Composer, type ComposerProps } from '../../components/composer.tsx';
import type { ComposerAttachmentUploader } from '../../components/composer-attachments.ts';
import { useComposerPreferences } from '../../hooks/use-composer-preferences.ts';
import { useLayoutMode } from '../../hooks/use-layout-mode.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../lib/drafts.ts';
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

interface SendBackTarget {
  /** The card's machine. */
  readonly daemon: DaemonConnection;
  /** The card's ferret; the box's files are uploaded to its session, and its draft is kept under it. */
  readonly sessionId: string;
}

export interface BoardSendBackProps {
  /** What is being sent back, e.g. `Not good: send Pairing QR back to Implement`. */
  readonly heading: string;
  readonly target: SendBackTarget;
  /** Something outside the box is working on this card: the box waits. */
  readonly busy: boolean;
  /** A refusal the host already holds, shown above the box. */
  readonly error: string | null;
  /** Resolves to the refusal, or `null` when it went; a refusal keeps the words and files in the box. */
  readonly onSubmit: (sendBack: SendBack) => Promise<string | null> | string | null | undefined;
  readonly onCancel: () => void;
  /** Files for this card's ferret; `null` draws the words alone. */
  readonly files: SendBackFiles | null;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  /** The words may be left empty: the answer goes without them (a "Not yet"). */
  readonly wordsOptional?: boolean;
}

/**
 * The box a refusal's words are written in. Its draft is the box's own: it is kept nowhere (a store that
 * writes nothing), so what is typed for one card is never another's, and never the chat's.
 */
const NEVER_KEPT = new DaemonDraftStore({ getItem: () => null, setItem: () => undefined });

export function BoardSendBack({
  heading,
  target,
  busy,
  error,
  onSubmit,
  onCancel,
  files,
  placeholder = 'What is not good? The ferret reads this.',
  submitLabel = 'Send back',
  wordsOptional = false,
}: BoardSendBackProps) {
  const headingId = useId();
  const preferences = useComposerPreferences(target.daemon.daemonId);
  const phone = useLayoutMode() === 'drawer';
  const attachable = files !== null && files.offered === true;
  const submitNow = useRef(onSubmit);
  submitNow.current = onSubmit;
  // The composer's send is the host's move, not a chat message: nothing reaches a session from here.
  const api = useMemo(
    () =>
      ({
        send: async (_session: string, input: { readonly message: string; readonly attachmentIds?: string[] }) => {
          if (input.message.length > MAX_BOARD_REASON_LENGTH)
            throw new Error(`That is too long: keep it under ${String(MAX_BOARD_REASON_LENGTH)} characters.`);
          const refused = await submitNow.current({ reason: input.message, attachmentIds: input.attachmentIds ?? [] });
          if (typeof refused === 'string') throw new Error(refused);
          return {};
        },
      }) as unknown as ComposerProps['api'],
    [],
  );
  const onKeyDown = (event: KeyboardEvent): void => {
    // Esc anywhere in the box but the field (the Cancel button, the picker) goes back too.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      aria-busy={busy}
      aria-labelledby={headingId}
      aria-modal="true"
      className="fy-board-reason fy-board-sendback"
      data-board-send-back=""
      onKeyDown={onKeyDown}
      role="dialog"
    >
      <div className="fy-board-sendback__head">
        <p className="fy-board-reason__heading" id={headingId}>
          {heading}
        </p>
        <button
          className="kt-btn kt-btn--sm fy-board-sendback__cancel"
          data-variant="ghost"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
      {error === null ? null : (
        <p className="fy-board-reason__error" role="alert">
          {error}
        </p>
      )}
      {files !== null && files.offered === false ? (
        <p className="fy-board-sendback__note" data-send-back-note="update">
          {SEND_BACK_FILES_NEED_UPDATE}
        </p>
      ) : null}
      <Composer
        allowEmptySend={wordsOptional}
        api={api}
        autoFocus
        compact={phone}
        daemon={target.daemon}
        detached={{ sendLabel: submitLabel, attachable, maxAttachments: MAX_BOARD_REOPEN_ATTACHMENTS }}
        disabled={busy}
        draftStore={NEVER_KEPT}
        placeholder={placeholder}
        sessionId={target.sessionId}
        {...preferences}
        {...(attachable ? { uploadAttachment: files.upload } : {})}
      />
    </div>
  );
}
