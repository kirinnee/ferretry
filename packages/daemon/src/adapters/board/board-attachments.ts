import type { BoardAttachment } from '@ferretry/protocol';
import type { BoardAttachmentSource } from '../../lib/board/index.ts';
import type { SessionAttachmentStore } from '../../lib/attachments/session-attachments.ts';

/**
 * Moves the files the owner attached to a move back from the session the app uploaded them to into the session
 * of the ferret that is told. Answers the ids as they are THERE; rejects when a file cannot be carried.
 */
export interface ReopenAttachmentCarrier {
  carry(from: string, to: string, ids: readonly string[]): Promise<readonly string[]>;
}

/**
 * THE BOARD'S VIEW OF THE ATTACHMENT STORE: what a "Not good" with pictures needs from it, and nothing more.
 *
 * `describe` names each file for the card's history from its manifest alone (the session's own listing), and
 * refuses an id the session does not hold. `carry` copies an original into another session through the
 * store's own download and upload, so the copy is checked against its manifest on the way out and gets a
 * manifest of its own on the way in. The store addresses a file by its content (`att_<sha256>`), so the copy
 * has the same id, and carrying a file that is already there is a no-op.
 */
export class StoreBoardAttachments implements BoardAttachmentSource, ReopenAttachmentCarrier {
  constructor(private readonly store: Pick<SessionAttachmentStore, 'list' | 'download' | 'upload'>) {}

  async describe(sessionId: string, ids: readonly string[]): Promise<readonly BoardAttachment[]> {
    const held = new Map((await this.store.list(sessionId)).map(view => [view.id, view]));
    return ids.map(id => {
      const view = held.get(id);
      if (view === undefined) throw new Error(`no attachment ${id}`);
      return { id: view.id, filename: view.filename, mime: view.mime };
    });
  }

  async carry(from: string, to: string, ids: readonly string[]): Promise<readonly string[]> {
    if (from === to) return ids;
    const carried: string[] = [];
    for (const id of ids) {
      const { attachment, bytes } = await this.store.download(from, id);
      const copy = await this.store.upload(to, { filename: attachment.filename, mime: attachment.mime, bytes });
      carried.push(copy.id);
    }
    return carried;
  }
}
