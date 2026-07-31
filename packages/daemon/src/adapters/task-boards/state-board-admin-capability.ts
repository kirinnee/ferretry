import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import { mintToken } from '../api/state-api-credentials.ts';

/** Owner read/write only, for the same reason the API token file is: another local account that can
 *  read this file can create boards and replace coordinators on them. */
const CAPABILITY_MODE = 0o600;

/**
 * The OPERATOR's board capability, held in the state home.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT AN INVENTED SECURITY BOUNDARY. `fy task-board create` —
 * and `mark-done`, `coordinator-replace`, `revoke` — authenticate with `FY_BOARD_ADMIN_CAPABILITY`,
 * which `packages/cli/src/lib/task-boards/board-credentials.ts` documents as "deliberately
 * unavailable inside a teammate pane". Four wiring units recorded that nothing minted it and that
 * inventing a distribution mechanism was a decision a wiring unit should not make alone.
 *
 * It is the same decision this daemon already made, for the same principal, one file over:
 * `StateApiCredentials` mints the human's API token into `<state home>/api-token` at 0600 on first
 * boot and the operator exports what `fyd` issued. This is that secret's sibling — same mint, same
 * mode, same home, same delivery — so the distribution mechanism is not new, and the only thing that
 * would have been new is a second, different one.
 *
 * WHY IT IS A SEPARATE SECRET FROM THE ADMIN API TOKEN. The CLI sends them in different headers and
 * the daemon checks them at different boundaries: the bearer token decides whether a request may be
 * SERVED at all, and this decides whether the caller is the human rather than a pane that holds the
 * shared bearer. Collapsing them would make every teammate an operator, because a teammate's `fy`
 * already carries the API token.
 *
 * WHY IT IS NEVER COMPARED WITH `===`. A board admin capability is a secret, so it is compared
 * through its SHA-256 rather than by walking the plaintext — the hash comparison is fixed-width and
 * leaks no prefix oracle regardless of how the two strings differ.
 */
export class StateBoardAdminCapability {
  private readonly path: string;
  private cached?: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly mint: () => string = mintToken,
  ) {
    this.path = join(paths.home, 'board-admin-capability');
  }

  /**
   * The hash of the operator's capability, minting and persisting one when the file is absent or has
   * been emptied.
   *
   * A blank file is treated as absent for the reason the token file gives: an empty secret
   * authenticates nothing, so leaving it in place would refuse the operator access to their own
   * boards with no diagnosable cause.
   */
  async hash(): Promise<string> {
    return createHash('sha256')
      .update(await this.capability(), 'utf8')
      .digest('hex');
  }

  /** Where the operator reads it from. Reported by the daemon's own logs so it is discoverable. */
  file(): string {
    return this.path;
  }

  private async capability(): Promise<string> {
    if (this.cached !== undefined) return this.cached;
    const existing = (await this.files.readText(this.path))?.trim();
    if (existing !== undefined && existing !== '') {
      this.cached = existing;
      return existing;
    }
    const minted = this.mint();
    await this.files.writeTextAtomic(this.path, `${minted}\n`);
    await this.files.setMode(this.path, CAPABILITY_MODE);
    this.cached = minted;
    return minted;
  }
}
