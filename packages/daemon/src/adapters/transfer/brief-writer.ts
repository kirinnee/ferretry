import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { TransferBriefWriter } from '../../lib/transfer/types.ts';
import { type DurableArtifactIo, TransferArtifactDurability } from './durable-artifact.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The brief is deterministic, so "matching" is byte equality with the document the plan renders. */
function isDocument(document: string): (bytes: Buffer) => boolean {
  return bytes => bytes.toString('utf8') === document;
}

/**
 * Atomic, POWER-LOSS DURABLE, target-keyed persistence for the deterministic first-turn brief.
 *
 * The brief is the LAST import step, and the fork advances its durable receipt to `imported` as soon
 * as import returns. So this call may only return once the document is on the medium under its final
 * name: a `rename` whose bytes and whose directory entry are still in the page cache would let a
 * durable `imported` receipt outlive the only opening turn the new agent is ever pointed at, and the
 * replay refuses that target rather than rebuilding it. {@link TransferArtifactDurability} owns that
 * contract — it is shared with the attachment copier so the two artifacts one receipt vouches for
 * cannot drift into subtly different guarantees.
 *
 * A replay is durable too: identical bytes are proved and flushed through one handle, and the path is
 * confirmed to still resolve to that inode, rather than trusted — because "the file reads back
 * correctly" is exactly what a page cache offers a moment before power is cut, and a name can stop
 * meaning the file whose bytes were read. A replay that cannot get that far writes the document
 * itself, which it can always do: the brief is rendered from the frozen plan.
 */
export class FileSessionTransferBriefWriter implements TransferBriefWriter {
  private readonly durability: TransferArtifactDurability;

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    uniqueId: () => string = randomUUID,
    io?: DurableArtifactIo,
  ) {
    this.durability = new TransferArtifactDurability(uniqueId, io);
  }

  file(newSessionId: string): string {
    this.assertSessionId(newSessionId);
    return join(this.sessionDirectory(newSessionId), 'turns', 'turn-001.md');
  }

  async write(newSessionId: string, document: string): Promise<string> {
    const file = this.file(newSessionId);
    const directory = dirname(file);
    const durableAncestor = this.durableAncestorOf(newSessionId);

    // A matching replay has proved VISIBILITY, not durability, and it returns to a caller that is
    // about to commit `imported`. Proof and flush share one handle, the names it depends on are
    // persisted, and the path is then confirmed to still resolve to that same inode — so this return
    // means what the first writer's meant. Anything less and this attempt writes its own bytes, which
    // it can always do: the document is rendered from the frozen plan.
    const artifact = { file, proves: isDocument(document) };
    if (await this.durability.proveDurable(directory, durableAncestor, [artifact])) return file;

    // Publishes, then confirms the name still resolves to the inode it flushed — a concurrent rename
    // over `turn-001.md` would otherwise leave this return vouching for bytes nothing here synced.
    await this.durability.materialize(directory, durableAncestor, [{ ...artifact, bytes: document }]);
    return file;
  }

  /**
   * Read-only proof used before a fork may launch an already-imported target.
   *
   * Deliberately does not flush: this caller REFUSES drift rather than repairing it, so it must leave
   * the medium exactly as it found it.
   */
  async matches(newSessionId: string, expected: string): Promise<boolean> {
    return await this.durability.proveVisible([{ file: this.file(newSessionId), proves: isDocument(expected) }]);
  }

  /**
   * The ancestor whose own directory entry is taken as already durable: the STATE ROOT.
   *
   * The layout is `<state>/sessions/<id>`, so the anchor is two levels above it, and the SESSIONS ROOT
   * is deliberately not it. The `<id>` entry inside `<sessions>` is durable by the time import runs —
   * `StorageSessionLifecycleRepository.reserve` flushes the session directory and then `<sessions>` on
   * every reservation — but the entry naming `<sessions>` itself inside `<state>` is flushed by nobody:
   * `StateFileSystem.ensureDirectory` is a plain recursive `mkdir`. Anchoring at `<sessions>` would
   * make this brief's durability rest on a flush no owner performs, which is exactly the boundary the
   * attachment copier declares one level up for the same reason.
   *
   * Naming a higher ancestor is the safe direction: every ancestor of the artifact directory exists
   * once the tree is ensured, so a resolver composed at a different depth only widens the flushed
   * chain — it can never name a directory that is not there.
   */
  private durableAncestorOf(newSessionId: string): string {
    return dirname(dirname(this.sessionDirectory(newSessionId)));
  }

  private assertSessionId(value: string): void {
    if (!SESSION_ID.test(value) || value === '.' || value === '..') {
      throw new Error('target session id is not usable');
    }
  }
}
