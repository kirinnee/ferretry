/**
 * Turn-one storage inside the session's own private directory.
 *
 * DURABLE BEFORE IT ANSWERS, because of what happens immediately after it. The lifecycle writes this
 * document, then hands the agent its first turn, and the durable effect that records "turn one was
 * delivered" is begun the instant the launcher is about to touch the pane. A document that had only
 * reached the page cache leaves a power cut able to produce the one combination nothing downstream
 * can repair: a durable imported receipt and a durable begun effect, naming a turn-one file that is
 * not there. The replay skips the import because the receipt says it happened, and refuses the
 * effect because it began — so the session exists, holds a conversation, and can never be given the
 * assignment it was created for. So the bytes, the file's own directory entry and the entry naming
 * that directory are all persisted before this returns — by the kernel's `RootHandle.publish`, which
 * syncs the ancestors parent first, writes a synced temp file, moves it onto the name and syncs the
 * folder.
 *
 * AN EXACT REPLAY IS SYNCED, NOT REWRITTEN. A retried launch and a fork's replay both arrive with
 * byte-identical content — the fork deliberately renders this document and the transfer brief from
 * one function so they cannot disagree — and replacing the inode under an identical file is not
 * free: anything holding the old one keeps reading a file no name points at, and the agent may be
 * mid-read of the very document it was told to open. So identical bytes are proved durable in place
 * (`RootHandle.readDurable` with `hold` reads and fsyncs ONE descriptor and keeps it open until the end), and the path is proved to still reach
 * that file before the call returns — a concurrent writer that published over the name during the
 * directory sync is a refusal, never a silent claim about a document nothing points at.
 */

import { dirname } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { ferretTurnFile } from '../../../../contract/sessions-root.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionTaskStore } from '../../../lib/session/lifecycle/index.ts';
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** What this store asks of the kernel's root. */
export type TaskRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'ensurePrivateDirectory' | 'resolve' | 'publish' | 'readDurable' | 'syncDirectory'
>;

export class FileSessionTaskStore implements SessionTaskStore {
  private readonly folder: OwnFolder;

  constructor(
    private readonly root: TaskRoot,
    private readonly ferret: SessionId,
  ) {
    assertSessionsRoot(root, 'the session task store');
    this.folder = new OwnFolder(root);
  }

  file(id: SessionId): FencedPath {
    assertOwnSession(this.ferret, id, 'the session task store');
    const resolved = this.root.resolve(ferretTurnFile(1));
    if (!resolved.ok) throw new Error(`the session's turn document is outside its root (${resolved.error})`);
    return resolved.value;
  }

  async writeAssignedTask(id: SessionId, document: string): Promise<string> {
    await this.folder.ensure();
    const file = this.file(id);
    // An exact replay proves what is already there rather than replacing it — and HOLDS the file it proved until
    // the very end (the descriptor pins the inode, so it cannot be freed and reused), because the claim is about the
    // file this path NAMES when the call returns, not about the one it named a moment ago. Differing bytes are about
    // to be replaced anyway, so they take the publish path.
    const bytes = new TextEncoder().encode(document);
    const replayed = await this.root.readDurable(file, undefined, async held => {
      if (new TextDecoder().decode(held.bytes) !== document) return false;
      // The folder's own entry and the entry naming it, parent first.
      await this.root.syncDirectory(dirname(file) as FencedPath, { parent: true });
      await this.assertStillNames(file, held.stillNames);
      return true;
    });
    if (replayed === true) return file;
    await this.root.publish(file, bytes, { mode: 0o600 });
    return file;
  }

  /**
   * Refuses if the path stopped naming the file this call proved.
   *
   * WHY THE COMPARE IS AT THE END. Everything before it is true of a file; the promise this method
   * makes is about a PATH — that `turns/turn-001.md` holds these exact bytes, durably, when the call
   * returns. A concurrent writer publishing by rename during the directory sync substitutes the file
   * underneath without touching what was read, so a caller told "your identical replay is durable" would
   * be holding a guarantee about a document nothing points at any more.
   *
   * It REFUSES rather than falling through to the replace path. Reaching here means somebody else
   * just published a document at this name, and overwriting it would destroy a write that won a race
   * this call did not know it was in. A refusal fails the launch, which the lifecycle already records
   * and a retry re-drives against whatever is genuinely there.
   */
  private async assertStillNames(file: FencedPath, stillNames: () => Promise<boolean>): Promise<void> {
    if (await stillNames()) return;
    throw new Error(
      `${file} stopped naming the turn-one document this write proved: another writer published over ` +
        'it, so this call refuses rather than overwriting a document it never read',
    );
  }
}
