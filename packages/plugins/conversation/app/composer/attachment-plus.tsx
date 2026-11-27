/**
 * The PLUS on a stored attachment's tile: put a reference to that file in this ferret's message box.
 *
 * The delivery is Conversation's shared Add to chat (`addToChatFor`, the same action `conversation.add-to-chat` hands
 * every other surface), so the token reaches only the composer of THIS daemon and THIS ferret, and says its outcome in
 * the one set of words every caller uses. The token is `%attachment:<attachment id>/<delivered name>`
 * (docs/reference-standard.md): the last two parts of the path the agent was handed the file at, so two files of one
 * name are two tokens and each names its own copy.
 *
 * A file whose delivered name the grammar cannot write down (one that ends in a dot or a dash) says so in those words
 * instead of inserting something the reader could never prove.
 */

import { deliveredFilename } from '@ferretry/core-mailbox/contract';
import { cn } from '@ferretry/app/ui';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { referenceToken } from './composer-references.ts';
import { addToChatFor } from './add-to-chat.ts';
import type { StoredTranscriptAttachment } from './attachments.ts';
import type { DaemonConnection } from './seam.ts';

/** The canonical `%attachment:` token of a stored file, or `null` when its id or delivered name cannot be written. */
export const attachmentToken = (
  attachment: Pick<StoredTranscriptAttachment, 'attachmentId' | 'filename'>,
): string | null =>
  referenceToken({
    kind: 'surface',
    surface: 'attachment',
    key: `${attachment.attachmentId}/${deliveredFilename(attachment.filename)}`,
  });

interface AttachmentPlusProps {
  readonly daemon: DaemonConnection;
  readonly attachment: StoredTranscriptAttachment;
  readonly className?: string;
}

/** The plus and the sentence it answers with. The sentence is rendered by the caller's column, below the tile. */
export const useAttachmentPlus = ({ daemon, attachment }: Omit<AttachmentPlusProps, 'className'>) => {
  const [note, setNote] = useState('');
  const add = () => {
    const token = attachmentToken(attachment);
    setNote(
      token === null
        ? 'That file’s name cannot be written as a reference, so it was not added.'
        : addToChatFor(daemon.daemonId).add(attachment.ferretId, token).message,
    );
  };
  return { note, add };
};

export const AttachmentPlusButton = ({
  add,
  filename,
  className,
}: {
  readonly add: () => void;
  readonly filename: string;
  readonly className?: string;
}) => (
  <button
    type="button"
    onClick={add}
    aria-label={`Add ${filename} to the message`}
    title="Add to the message"
    className={cn(
      'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      className,
    )}
  >
    <Plus size={16} aria-hidden="true" />
  </button>
);

export const AttachmentPlusNote = ({ note }: { readonly note: string }) =>
  note === '' ? null : (
    <span className="block text-meta text-faint" role="status">
      {note}
    </span>
  );

/**
 * A picture's Expand control with the plus BESIDE it, never over it: on a 16px picture the Expand target is 44px, and
 * a plus laid on the picture would sit on top of it. Both stay 44px targets, 8px apart, and the plus's sentence goes
 * under the pair. Without an attachment (an inline picture) the picture is returned as it is.
 */
export const AttachmentWithPlus = ({
  daemon,
  attachment,
  children,
}: {
  readonly daemon: DaemonConnection;
  readonly attachment: StoredTranscriptAttachment | undefined;
  readonly children: ReactNode;
}) =>
  attachment === undefined ? (
    children
  ) : (
    <PictureWithPlus daemon={daemon} attachment={attachment}>
      {children}
    </PictureWithPlus>
  );

const PictureWithPlus = ({
  daemon,
  attachment,
  children,
}: {
  readonly daemon: DaemonConnection;
  readonly attachment: StoredTranscriptAttachment;
  readonly children: ReactNode;
}) => {
  const plus = useAttachmentPlus({ daemon, attachment });
  return (
    <div className="w-fit max-w-full">
      <div className="flex max-w-full items-start gap-2">
        {children}
        <AttachmentPlusButton
          add={plus.add}
          filename={attachment.filename}
          className="shrink-0 border border-border-soft bg-surface-2"
        />
      </div>
      <AttachmentPlusNote note={plus.note} />
    </div>
  );
};
