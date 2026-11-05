/**
 * The proof behind `%attachment:name`: an index of the stored attachments this session's LOADED transcript
 * carries.
 *
 * A name proves only against a file the reader can see in this conversation. There is no daemon route for it
 * on purpose — the transcript rows that already read their hand-off documents (`handoff-message.tsx`) record
 * what they carry here, so a reference is proved by the very tiles it points back to, and a file that is not
 * on the page (or in a session this page does not hold) stays plain text.
 *
 * WHICH FILE A NAME MEANS. Names are the DELIVERED name — the last segment of the path the ferret was
 * handed — so two different files can share one in a long session. The rule is: the file of that name on the
 * SAME message first, else the NEWEST in the session. That is a declared GAP, not a guess dressed as proof:
 * an older file of the same name is reachable only through its own message. The + on a tile re-attaches the
 * exact file, so the ferret still receives the one the reader meant.
 *
 * "Newest" follows the hand-off document's own name: `turn-<n>` counts up, and a `queued-…` send is behind
 * every delivered turn. Two files on one message are ranked by the order the message lists them.
 */

import type { DaemonId } from './daemon-connection.ts';
import { isAttachmentReferenceName, type ResolvedAttachment } from './references.ts';

/** One stored file a message carries, as its tile knows it. */
export interface IndexedAttachment {
  readonly attachmentId: string;
  /** The delivered name: what the reference writes. */
  readonly filename: string;
}

interface Entry extends IndexedAttachment {
  readonly message: string;
  readonly rank: number;
  readonly order: number;
}

/** A hand-off document's place in time: `turn-8` is 8, a queued send is behind every turn. */
const messageRank = (message: string): number => {
  const turn = /^turn-(\d{1,9})$/u.exec(message);
  return turn?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(turn[1]);
};

/** The stored attachments of one session's loaded messages, observable so a reference proves once its file loads. */
export class AttachmentIndex {
  #entries: Entry[] = [];
  #version = 0;
  #listeners = new Set<() => void>();

  /**
   * Records what one message carries; recording the same message again replaces it. A message with no files
   * records nothing: one hand-off document is drawn more than once (a combined delivery splits its words
   * across rows and puts the files under the last), and a row that shows none of them must not erase what the
   * row that does has recorded.
   */
  record(message: string, files: readonly IndexedAttachment[]): void {
    if (files.length === 0) return;
    const rank = messageRank(message);
    const next = files.map((file, order): Entry => ({ ...file, message, rank, order }));
    const before = this.#entries.filter(entry => entry.message === message);
    if (
      before.length === next.length &&
      before.every(
        (entry, at) => entry.attachmentId === next[at]?.attachmentId && entry.filename === next[at]?.filename,
      )
    )
      return;
    this.#entries = [...this.#entries.filter(entry => entry.message !== message), ...next];
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Changes whenever what the index can prove does; the snapshot for `useSyncExternalStore`. */
  readonly version = (): number => this.#version;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The file a name means: the one on `local` (the message the reference is written in) first, else the newest. */
  find(name: string, local: readonly IndexedAttachment[] = []): IndexedAttachment | undefined {
    const here = local.findLast(file => file.filename === name);
    if (here !== undefined) return here;
    let best: Entry | undefined;
    for (const entry of this.#entries) {
      if (entry.filename !== name) continue;
      if (
        best === undefined ||
        entry.rank > best.rank ||
        (entry.rank === best.rank && entry.message === best.message && entry.order > best.order)
      )
        best = entry;
    }
    return best;
  }
}

/** The scope an attachment resolver answers for: one session on one daemon. */
export interface AttachmentReferenceScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

/**
 * The resolver `Markdown` takes. Pass the carrying message's own files as `local` and a reference inside that
 * message resolves to its own file before any newer file of the same name.
 */
export const createAttachmentReferenceResolver =
  (scope: AttachmentReferenceScope, index: AttachmentIndex, local: readonly IndexedAttachment[] = []) =>
  (name: string): ResolvedAttachment | null => {
    if (!isAttachmentReferenceName(name)) return null;
    const found = index.find(name, local);
    return found === undefined
      ? null
      : { daemonId: scope.daemonId, sessionId: scope.sessionId, attachmentId: found.attachmentId, name };
  };

/** How long the tile a reference scrolled to keeps its ring. */
const ATTACHMENT_FLASH_MS = 1_900;

/**
 * Scrolls to the tile that shows a stored attachment and rings it for a moment. The tile in the SAME message as
 * the chip that was clicked wins, so a reference to a file its own message carries goes nowhere else; failing
 * that, the newest tile on the page. Answers whether a tile was found — a message scrolled out of the loaded
 * transcript has no tile to reach.
 */
export const revealAttachmentTile = (
  root: ParentNode,
  attachmentId: string,
  opener?: Element | null,
  timers: Pick<typeof globalThis, 'setTimeout'> = globalThis,
): boolean => {
  const selector = `[data-attachment-id="${attachmentId.replaceAll('"', '')}"]`;
  const tile =
    opener?.closest('[data-handoff]')?.querySelector<HTMLElement>(selector) ??
    [...root.querySelectorAll<HTMLElement>(selector)].at(-1);
  if (tile === undefined || tile === null) return false;
  tile.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  tile.setAttribute('data-attachment-flash', '');
  timers.setTimeout(() => tile.removeAttribute('data-attachment-flash'), ATTACHMENT_FLASH_MS);
  return true;
};
