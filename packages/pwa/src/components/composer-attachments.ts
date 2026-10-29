/**
 * THE COMPOSER'S PENDING FILES — what ＋, a drop and a paste add, and what a send names.
 *
 * Each file is uploaded the moment it is added, so by the time the reader presses send the daemon
 * already holds it and the send only names ids. A file the browser can already tell is unusable — empty,
 * too large, a type nothing reads — is refused locally with the curated copy and never travels.
 *
 * AT MOST {@link MAX_CONCURRENT_UPLOADS} GO AT ONCE, and the rest wait their turn. Twenty-one phone
 * photos used to start together: twenty-one base64 copies in the tab's memory, all queued on one
 * connection, so the first drop failed every one of them. A failure a moment can change — a dropped
 * connection, a busy machine — is tried again on its own, {@link UPLOAD_ATTEMPTS} times in all, and
 * the chip says so while it waits; only what is still failing after that asks the reader to act.
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
  isTransientUploadFailure,
  UPLOAD_QUEUED_COPY,
  uploadRetryingCopy,
  validateAttachmentFile,
} from '../lib/attachments.ts';
import type { PendingAttachment } from './session-chat-model.ts';

/** Uploads one file to the session this composer belongs to. */
export type ComposerAttachmentUploader = (file: File) => Promise<AttachmentView>;

/** Uploads in flight at once; the rest wait, in the order they were added. */
export const MAX_CONCURRENT_UPLOADS = 3;

/** Attempts per file, the first included, before a transient failure is shown as a failure. */
export const UPLOAD_ATTEMPTS = 4;

/** The wait before attempt `n + 1`: long enough for a phone to find its connection again. */
export const UPLOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

/** How the hook waits between attempts; injected so a test does not sleep. */
export type RetryWait = (milliseconds: number) => Promise<void>;

const sleep: RetryWait = async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds));

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

export function useComposerAttachments(
  upload: ComposerAttachmentUploader | undefined,
  scopeKey: string,
  wait: RetryWait = sleep,
) {
  const [entries, setEntries] = useState<readonly PendingAttachment[]>([]);
  const live = useRef(entries);
  live.current = entries;
  const sequence = useRef(0);
  /** Files waiting for a slot, oldest first, and how many slots are taken. */
  const queue = useRef<PendingAttachment[]>([]);
  const running = useRef(0);
  /** Bumped by every reset, so an upload that outlives its scope cannot write into the next one. */
  const generation = useRef(0);
  /** Files removed or reset away; an upload still running for one is not retried and not reported. */
  const gone = useRef(new Set<string>());

  const patch = useCallback((localId: string, next: Partial<PendingAttachment>) => {
    setEntries(current => current.map(entry => (entry.localId === localId ? { ...entry, ...next } : entry)));
  }, []);

  const settle = useCallback(
    (localId: string, next: Partial<PendingAttachment>) =>
      setEntries(current =>
        current.map(entry => {
          if (entry.localId !== localId) return entry;
          const { note: _note, error: _error, ...rest } = entry;
          return { ...rest, ...next };
        }),
      ),
    [],
  );

  const attempt = useCallback(
    async (entry: PendingAttachment, uploader: ComposerAttachmentUploader, epoch: number): Promise<void> => {
      const current = (): boolean => epoch === generation.current && !gone.current.has(entry.localId);
      for (let tried = 1; ; tried += 1) {
        if (!current()) return;
        // A file that waited for a slot stops saying so the moment it starts.
        if (tried === 1) settle(entry.localId, {});
        try {
          const view = await uploader(entry.file);
          if (current()) settle(entry.localId, { status: 'ready', view });
          return;
        } catch (error) {
          if (!current()) return;
          if (tried >= UPLOAD_ATTEMPTS || !isTransientUploadFailure(error)) {
            settle(entry.localId, { status: 'failed', error: attachmentErrorMessage(error) });
            return;
          }
          patch(entry.localId, { note: uploadRetryingCopy(tried + 1, UPLOAD_ATTEMPTS) });
          await wait(UPLOAD_RETRY_DELAYS_MS[tried - 1] ?? UPLOAD_RETRY_DELAYS_MS.at(-1) ?? 0);
        }
      }
    },
    [patch, settle, wait],
  );

  const pump = useCallback(() => {
    if (upload === undefined) return;
    while (running.current < MAX_CONCURRENT_UPLOADS) {
      const next = queue.current.shift();
      if (next === undefined) return;
      if (gone.current.has(next.localId)) continue;
      running.current += 1;
      const epoch = generation.current;
      void attempt(next, upload, epoch).finally(() => {
        // A slot freed by an upload from before a reset belongs to nothing any more.
        if (epoch !== generation.current) return;
        running.current -= 1;
        pump();
      });
    }
  }, [attempt, upload]);

  const start = useCallback(
    (entry: PendingAttachment) => {
      if (upload === undefined) return;
      queue.current.push(entry);
      if (running.current >= MAX_CONCURRENT_UPLOADS) patch(entry.localId, { note: UPLOAD_QUEUED_COPY });
      pump();
    },
    [patch, pump, upload],
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
    gone.current.add(entry.localId);
    setEntries(current => current.filter(candidate => candidate.localId !== entry.localId));
  }, []);

  const retry = useCallback(
    (entry: PendingAttachment) => {
      setEntries(current =>
        current.map(candidate => {
          if (candidate.localId !== entry.localId) return candidate;
          const { error: _error, note: _note, ...rest } = candidate;
          return { ...rest, status: 'uploading' as const };
        }),
      );
      start(entry);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const entry of live.current) revoke(entry);
    generation.current += 1;
    queue.current = [];
    running.current = 0;
    gone.current = new Set();
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
