import type { StatePort } from '@ferretry/kernel/contract';
import { TransferBriefFiles } from '../../../contract/transfer-state.ts';
import type { TransferBriefWriter } from '../../lib/transfer/types.ts';
import { type PublishableArtifact, TransferArtifactDurability } from './durable-artifact.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The brief is deterministic, so "matching" is byte equality with the document the plan renders. */
function isDocument(document: string): (bytes: Uint8Array) => boolean {
  return bytes => decoder.decode(bytes) === document;
}

/**
 * Atomic, POWER-LOSS DURABLE, target-keyed persistence for the deterministic first-turn brief.
 *
 * The brief is the LAST import step, and the fork advances its durable receipt to `imported` as soon
 * as import returns. So this call may only return once the document is on the medium under its final
 * name: a durable `imported` receipt must not outlive the only opening turn the new agent is ever
 * pointed at, and the replay refuses that target rather than rebuilding it. The state port writes the
 * file atomically and flushes it; {@link TransferArtifactDurability} owns the contract on top of that —
 * it is shared with the attachment copier so the two artifacts one receipt vouches for cannot drift
 * into subtly different guarantees.
 *
 * A replay is durable too: identical bytes are proved and then republished through the port, and the
 * name is confirmed to still hold them, rather than trusted — because "the file reads back correctly"
 * is exactly what a page cache offers a moment before power is cut. A replay that cannot get that far
 * writes the document itself, which it can always do: the brief is rendered from the frozen plan.
 */
export class FileSessionTransferBriefWriter implements TransferBriefWriter {
  private readonly durability = new TransferArtifactDurability();

  constructor(private readonly state: StatePort) {}

  /** Where the new agent is told to read its opening turn: the declared file's own path. */
  file(newSessionId: string): string {
    this.assertSessionId(newSessionId);
    return this.state.pathOf(TransferBriefFiles, newSessionId);
  }

  async write(newSessionId: string, document: string): Promise<string> {
    const file = this.file(newSessionId);
    const artifact = { ...this.artifact(newSessionId), proves: isDocument(document) };

    // A matching replay has proved VISIBILITY, not durability, and it returns to a caller that is
    // about to commit `imported`. The proved bytes are republished through the port and the name is
    // confirmed to still hold them, so this return means what the first writer's meant. Anything less
    // and this attempt writes its own bytes, which it can always do: the document is rendered from
    // the frozen plan.
    if (await this.durability.proveDurable([artifact])) return file;

    // Publishes, then confirms the name still holds what it published — a concurrent write over
    // `turn-001.md` would otherwise leave this return vouching for bytes nothing here made durable.
    await this.durability.materialize(file, [{ ...artifact, bytes: encoder.encode(document) }]);
    return file;
  }

  /**
   * Read-only proof used before a fork may launch an already-imported target.
   *
   * Deliberately does not write: this caller REFUSES drift rather than repairing it, so it must leave
   * the medium exactly as it found it.
   */
  async matches(newSessionId: string, expected: string): Promise<boolean> {
    this.assertSessionId(newSessionId);
    return await this.durability.proveVisible([{ ...this.artifact(newSessionId), proves: isDocument(expected) }]);
  }

  private artifact(newSessionId: string): Omit<PublishableArtifact, 'proves'> {
    this.assertSessionId(newSessionId);
    return {
      read: async () => {
        const read = await this.state.read(TransferBriefFiles, newSessionId);
        if (!read.ok) throw new Error(read.error.sentence);
        return read.value;
      },
      write: async bytes => await this.state.write(TransferBriefFiles, bytes, newSessionId),
    };
  }

  private assertSessionId(value: string): void {
    if (!SESSION_ID.test(value) || value === '.' || value === '..') {
      throw new Error('target session id is not usable');
    }
  }
}
