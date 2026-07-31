import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ApiCredentials } from '../../lib/api/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

/** Owner read/write only. The token authorizes every action the daemon can take, so a token file
 *  another local account can read is the whole security model gone. */
const TOKEN_MODE = 0o600;

/** 32 bytes of CSPRNG output, base64url so it survives a header, a query string and a shell. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The daemon's tokens, held in the state home.
 *
 * They are minted on first use rather than configured: a token in a configuration file is a token
 * in a backup, in a dotfile repository and in a screen share. Both tokens are always present, so
 * the warden-scoped surface exists from the first boot instead of appearing only once some later
 * subsystem happens to write one.
 */
export class StateApiCredentials {
  private readonly adminPath: string;
  private readonly wardenPath: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly mint: () => string = mintToken,
  ) {
    this.adminPath = join(paths.home, 'api-token');
    this.wardenPath = join(paths.home, 'api-warden-token');
  }

  async load(): Promise<ApiCredentials> {
    return { admin: await this.tokenAt(this.adminPath), warden: await this.tokenAt(this.wardenPath) };
  }

  /** Reads the token, minting and persisting one when the file is absent or has been emptied. A
   *  blank file is treated as absent: an empty secret authenticates nothing, so leaving it in place
   *  would lock the operator out of their own daemon with no diagnosable cause. */
  private async tokenAt(path: string): Promise<string> {
    const existing = (await this.files.readText(path))?.trim();
    if (existing !== undefined && existing !== '') return existing;
    const minted = this.mint();
    await this.files.writeTextAtomic(path, `${minted}\n`);
    await this.files.setMode(path, TOKEN_MODE);
    return minted;
  }
}
