/**
 * THE COMPOSER'S PENDING FILES — what ＋, a drop and a paste add, and what a send names.
 *
 * Each file is uploaded the moment it is added, so by the time the reader presses send the daemon
 * already holds it and the send only names ids. A file the browser can already tell is unusable — empty,
 * too large, a type nothing reads — is refused locally with the curated copy and never travels.
 *
 * Image previews are object URLs, and every one is revoked when its file leaves: on remove, on a
 * successful send, on a session change and on unmount. A leaked object URL is a leaked copy of the
 * file in this tab's memory.
 */

import type { AttachmentView } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachmentErrorCopy,
  attachmentErrorMessage,
  isImageMime,
  validateAttachmentFile,
} from '../lib/attachments.ts';
import type { PendingAttachment } from './session-chat-model.ts';

/** Uploads one file to the session this composer belongs to. */
export type ComposerAttachmentUploader = (file: File) => Promise<AttachmentView>;

/** Object URLs are a browser facility; a renderer with none previews nothing rather than failing. */
const previewUrl = (file: File): string | undefined => {
  if (!isImageMime(file.type) || typeof URL.createObjectURL !== 'function') return undefined;
  return URL.createObjectURL(file);
};

const revoke = (entry: PendingAttachment): void => {
  if (entry.objectUrl !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(entry.objectUrl);
};

interface ComposerAttachments {
  readonly entries: readonly PendingAttachment[];
  /** Ids of every file the daemon has accepted, in the order they were added. */
  readonly readyIds: readonly string[];
  /** A file is still uploading, so a send now would name an incomplete set. */
  readonly uploading: boolean;
  /** Files that did not reach the daemon: a send now would leave them out of the message without a word. */
  readonly failed: readonly PendingAttachment[];
  readonly add: (files: Iterable<File>) => void;
  readonly remove: (entry: PendingAttachment) => void;
  readonly retry: (entry: PendingAttachment) => void;
  /** Forget every file — after a successful send, or when the session changes. */
  readonly clear: () => void;
}

export function useComposerAttachments(upload: ComposerAttachmentUploader | undefined, scopeKey: string) {
  const [entries, setEntries] = useState<readonly PendingAttachment[]>([]);
  const live = useRef(entries);
  live.current = entries;
  const sequence = useRef(0);

  const patch = useCallback((localId: string, next: Partial<PendingAttachment>) => {
    setEntries(current => current.map(entry => (entry.localId === localId ? { ...entry, ...next } : entry)));
  }, []);

  const start = useCallback(
    (entry: PendingAttachment) => {
      if (upload === undefined) return;
      upload(entry.file).then(
        view => patch(entry.localId, { status: 'ready', view }),
        (error: unknown) => patch(entry.localId, { status: 'failed', error: attachmentErrorMessage(error) }),
      );
    },
    [patch, upload],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const added: PendingAttachment[] = [];
      for (const file of files) {
        sequence.current += 1;
        const localId = `local-${sequence.current}`;
        const refusal = validateAttachmentFile(file);
        const objectUrl = refusal === null ? previewUrl(file) : undefined;
        added.push({
          localId,
          file,
          ...(objectUrl === undefined ? {} : { objectUrl }),
          ...(refusal === null
            ? { status: 'uploading' as const }
            : { status: 'failed' as const, error: attachmentErrorCopy(refusal) }),
        });
      }
      setEntries(current => [...current, ...added]);
      for (const entry of added) if (entry.status === 'uploading') start(entry);
    },
    [start],
  );

  const remove = useCallback((entry: PendingAttachment) => {
    revoke(entry);
    setEntries(current => current.filter(candidate => candidate.localId !== entry.localId));
  }, []);

  const retry = useCallback(
    (entry: PendingAttachment) => {
      setEntries(current =>
        current.map(candidate => {
          if (candidate.localId !== entry.localId) return candidate;
          const { error: _error, ...rest } = candidate;
          return { ...rest, status: 'uploading' as const };
        }),
      );
      start(entry);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const entry of live.current) revoke(entry);
    setEntries([]);
  }, []);

  // A session change takes the pending files with it: they were uploaded to the PREVIOUS session, and
  // a send on this one could not name them. The scope key is the reset trigger, not an input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger
  useEffect(() => clear, [clear, scopeKey]);

  const readyIds = entries.flatMap(entry =>
    entry.status === 'ready' && entry.view !== undefined ? [entry.view.id] : [],
  );
  return {
    entries,
    readyIds,
    uploading: entries.some(entry => entry.status === 'uploading'),
    failed: entries.filter(entry => entry.status === 'failed'),
    add,
    remove,
    retry,
    clear,
  } satisfies ComposerAttachments;
}
