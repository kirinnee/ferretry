/**
 * The PLUS on a stored attachment's tile: put a reference to that file in this ferret's message box.
 *
 * The delivery is Conversation's shared Add to chat (`addToChatFor`, the same action `conversation.add-to-chat` hands
 * every other surface), so the token reaches only the composer of THIS daemon and THIS ferret, and says its outcome in
 * the one set of words every caller uses. The token is `%attachment:<delivered name>` (docs/reference-standard.md): the
 * name the agent was handed the file under, so the path it already has ends in what the token names.
 *
 * A file whose delivered name the grammar cannot write down (one that ends in a dot or a dash) says so in those words
 * instead of inserting something the reader could never prove.
 */

import { deliveredFilename } from '@ferretry/core-mailbox/contract';
import { cn } from '@ferretry/app/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { referenceToken } from './composer-references.ts';
import { addToChatFor } from './add-to-chat.ts';
import type { StoredTranscriptAttachment } from './attachments.ts';
import type { DaemonConnection } from './seam.ts';

/** The canonical `%attachment:` token of a stored file, or `null` when its delivered name cannot be written. */
export const attachmentToken = (attachment: Pick<StoredTranscriptAttachment, 'filename'>): string | null =>
  referenceToken({ kind: 'surface', surface: 'attachment', key: deliveredFilename(attachment.filename) });

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

/** The plus laid over a picture's top-right corner, with its sentence under the picture. */
export const AttachmentThumbnailPlus = ({ daemon, attachment }: Omit<AttachmentPlusProps, 'className'>) => {
  const plus = useAttachmentPlus({ daemon, attachment });
  return (
    <>
      <AttachmentPlusButton
        add={plus.add}
        filename={attachment.filename}
        className="absolute top-2 right-2 border border-border-soft bg-surface-2"
      />
      <AttachmentPlusNote note={plus.note} />
    </>
  );
};
