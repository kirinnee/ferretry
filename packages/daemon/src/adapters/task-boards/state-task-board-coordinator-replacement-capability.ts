import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type {
  TaskBoardCoordinatorReplacementCapabilityDeriver,
  TaskBoardCoordinatorReplacementCapabilityIdentity,
  TaskBoardSecret,
} from '../../lib/task-boards/types.ts';

const SEED_BYTES = 32;
const SEED_MODE = 0o600;
const DOMAIN = 'ferretry.task-board.coordinator-replacement.capability.v1';

/**
 * Recoverable coordinator-replacement material, keyed by this daemon's private state-home seed.
 *
 * The seed — not the operator bearer and not a caller-controlled request id — is the secret. HMAC
 * domain-separates this use and binds the logical operation to the board, its member locator, and the
 * replacement session's full incarnation/generation identity. Reopening the same state home therefore
 * reproduces byte-identical capability material without relying on the previous process or a cached
 * derived capability. Production derivation runs inside the serialized board transaction, and the
 * daemon's state-home lock prevents a second process racing the seed's first creation.
 */
export class StateTaskBoardCoordinatorReplacementCapability implements TaskBoardCoordinatorReplacementCapabilityDeriver {
  private readonly path: string;
  private cachedSeed?: Buffer;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    this.path = join(paths.home, 'task-board-coordinator-replacement-seed');
  }

  async derive(identity: TaskBoardCoordinatorReplacementCapabilityIdentity): Promise<TaskBoardSecret> {
    const requestId = identity.requestId.trim();
    if (requestId.length === 0) throw new Error('the coordinator replacement request id must not be empty');
    const value = createHmac('sha256', await this.seed())
      .update(
        JSON.stringify([
          DOMAIN,
          requestId,
          identity.boardId,
          identity.memberSessionId,
          identity.replacementSessionId,
          identity.replacementRootSessionId,
          identity.replacementSessionIncarnation,
          identity.replacementRuntimeGeneration,
        ]),
        'utf8',
      )
      .digest('base64url');
    return { value, hash: createHash('sha256').update(value, 'utf8').digest('hex') };
  }

  /** Exposed for permission and durability verification; callers never read the seed through it. */
  file(): string {
    return this.path;
  }

  private async seed(): Promise<Buffer> {
    if (this.cachedSeed !== undefined) return this.cachedSeed;
    const existing = await this.files.readText(this.path);
    if (existing !== undefined) {
      const encoded = existing.trim();
      if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
        throw new Error(`refusing to use an invalid task-board coordinator replacement seed at ${this.path}`);
      }
      const decoded = Buffer.from(encoded, 'base64url');
      this.cachedSeed = decoded;
      return decoded;
    }

    const minted = this.random(SEED_BYTES);
    if (minted.byteLength !== SEED_BYTES) {
      throw new Error('the coordinator replacement seed issuer must return exactly 32 bytes');
    }
    await this.files.writeTextAtomic(this.path, `${minted.toString('base64url')}\n`);
    await this.files.setMode(this.path, SEED_MODE);
    this.cachedSeed = minted;
    return minted;
  }
}
