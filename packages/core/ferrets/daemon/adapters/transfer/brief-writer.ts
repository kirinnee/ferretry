import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { ferretTurnFile } from '../../../contract/sessions-root.ts';
import type { TransferBriefWriter } from '../../lib/transfer/types.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import { assertSessionsRoot, OwnFolder } from '../session/sessions-root.ts';
import { type PublishableArtifact, TransferArtifactDurability } from './durable-artifact.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What this writer asks of a target's own `sessions` handle. */
export type BriefRoot = Pick<
  RootHandle,
  'name' | 'internal' | 'resolve' | 'ensurePrivateDirectory' | 'lstat' | 'readBytes' | 'publish'
>;

/** The brief is deterministic, so "matching" is byte equality with the document the plan renders. */
function isDocument(document: string): (bytes: Uint8Array) => boolean {
  return bytes => decoder.decode(bytes) === document;
}

/** The kernel's refusal word, read structurally: this plugin may not import the kernel's host. */
function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RootError') return undefined;
  const refusal = (error as { readonly refusal?: unknown }).refusal;
  return typeof refusal === 'string' ? refusal : undefined;
}

/**
 * Atomic, POWER-LOSS DURABLE, target-keyed persistence for the deterministic first-turn brief.
 *
 * WHERE: the target's own `turns/turn-001.md` in its private folder on the internal `sessions` root
 * (`state/ferrets/sessions/<ferret>/`, the contract's `FERRET_SESSIONS_FOLDER`) — today's
 * `<sessionDirectory>/turns/turn-001.md`. It is the target's turn one, the very file the lifecycle's assigned task
 * and every turn reader name, so there is no second copy anywhere else.
 *
 * The brief is the LAST import step, and the fork advances its durable receipt to `imported` as soon
 * as import returns. So this call may only return once the document is on the medium under its final
 * name: a durable `imported` receipt must not outlive the only opening turn the new agent is ever
 * pointed at, and the replay refuses that target rather than rebuilding it. The kernel's `publish` writes the
 * file atomically and syncs it and its folder; {@link TransferArtifactDurability} owns the contract on top of that —
 * it is shared with the attachment copier so the two artifacts one receipt vouches for cannot drift
 * into subtly different guarantees.
 *
 * A replay is durable too: identical bytes are proved and then republished, and the name is confirmed to still hold
 * them, rather than trusted — because "the file reads back correctly" is exactly what a page cache offers a moment
 * before power is cut. A replay that cannot get that far writes the document itself, which it can always do: the
 * brief is rendered from the frozen plan.
 */
export class FileSessionTransferBriefWriter implements TransferBriefWriter {
  private readonly durability = new TransferArtifactDurability();

  /** `root(id)`: the scoped `sessions` handle on that target's own folder. */
  constructor(private readonly root: (id: SessionId) => BriefRoot) {}

  /** Where the new agent is told to read its opening turn: the target's own `turns/turn-001.md`. */
  file(newSessionId: string): string {
    return this.target(newSessionId).file;
  }

  async write(newSessionId: string, document: string): Promise<string> {
    const target = this.target(newSessionId);
    const artifact = { ...this.artifact(target), proves: isDocument(document) };

    // A matching replay has proved VISIBILITY, not durability, and it returns to a caller that is
    // about to commit `imported`. The proved bytes are republished and the name is confirmed to still
    // hold them, so this return means what the first writer's meant. Anything less and this attempt
    // writes its own bytes, which it can always do: the document is rendered from the frozen plan.
    if (await this.durability.proveDurable([artifact])) return target.file;

    // Publishes, then confirms the name still holds what it published — a concurrent write over
    // `turn-001.md` would otherwise leave this return vouching for bytes nothing here made durable.
    await this.durability.materialize(target.file, [{ ...artifact, bytes: encoder.encode(document) }]);
    return target.file;
  }

  /**
   * Read-only proof used before a fork may launch an already-imported target.
   *
   * Deliberately does not write: this caller REFUSES drift rather than repairing it, so it must leave
   * the medium exactly as it found it (a target with no folder yet is not made one).
   */
  async matches(newSessionId: string, expected: string): Promise<boolean> {
    const target = this.target(newSessionId);
    return await this.durability.proveVisible([{ ...this.artifact(target), proves: isDocument(expected) }]);
  }

  private artifact(target: Target): Omit<PublishableArtifact, 'proves'> {
    return {
      read: async () => {
        // A folder not made yet holds no brief: the kernel answers a scoped handle on a missing folder `outside`.
        let leaf: Awaited<ReturnType<BriefRoot['lstat']>>;
        try {
          leaf = await target.root.lstat(target.file);
        } catch (error) {
          if (refusalOf(error) === 'outside') return undefined;
          throw error;
        }
        if (leaf === undefined) return undefined;
        return await target.root.readBytes(target.file);
      },
      write: async bytes => {
        await target.own.ensure();
        await target.root.publish(target.file, bytes, { mode: 0o600 });
      },
    };
  }

  private target(newSessionId: string): Target {
    const id = SESSION_ID.test(newSessionId) ? tryParseSessionId(newSessionId) : undefined;
    if (id === undefined) throw new Error('target session id is not usable');
    const root = this.root(id);
    assertSessionsRoot(root, 'the transfer brief writer');
    const file = root.resolve(ferretTurnFile(1));
    if (!file.ok) throw new Error('target session id is not usable');
    return { root, own: new OwnFolder(root), file: file.value };
  }
}

interface Target {
  readonly root: BriefRoot;
  readonly own: OwnFolder;
  readonly file: FencedPath;
}
