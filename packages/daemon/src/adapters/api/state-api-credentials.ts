import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiCredentials } from '../../lib/api/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

/** Owner read/write only. The token authorizes every action the daemon can take, so a token file
 *  another local account can read is the whole security model gone. */
const TOKEN_MODE = 0o600;

/** What the daemon needs to know about a token file BEFORE it trusts it: what the path itself is
 *  (not what it points at) and who owns it. */
export interface TokenFileFacts {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
}

export interface StateApiCredentialsOptions {
  readonly mint?: () => string;
  /** Looks at the path without following a link. Absent paths throw `ENOENT`. */
  readonly inspect?: (path: string) => Promise<TokenFileFacts>;
  /** The uid the daemon runs as; `undefined` on a host with no uids, where ownership is not checked. */
  readonly uid?: () => number | undefined;
}

/** A token file the daemon refuses to trust. The message is a plain sentence and never carries the
 *  credential, so it is safe to print on the boot path. */
export class ApiTokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiTokenFileError';
  }
}

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
 *
 * An existing file is never trusted on sight. The state home is `0700`, but a file can arrive with
 * looser bits (a restore, a copy, an old release) or as somebody else's file or link, and the daemon
 * is the one place that can say so before it hands the secret to every request. A file this account
 * does not own, or that is a link or not a regular file, stops the boot; a file with group or other
 * bits is made owner-only again.
 */
export class StateApiCredentials {
  private readonly adminPath: string;
  private readonly wardenPath: string;
  private readonly mint: () => string;
  private readonly inspect: (path: string) => Promise<TokenFileFacts>;
  private readonly uid: () => number | undefined;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
    options: StateApiCredentialsOptions = {},
  ) {
    this.adminPath = join(paths.home, 'api-token');
    this.wardenPath = join(paths.home, 'api-warden-token');
    this.mint = options.mint ?? mintToken;
    this.inspect = options.inspect ?? (async path => await lstat(path));
    this.uid = options.uid ?? (() => process.getuid?.());
  }

  async load(): Promise<ApiCredentials> {
    return { admin: await this.tokenAt(this.adminPath), warden: await this.tokenAt(this.wardenPath) };
  }

  /** Reads the token, minting and persisting one when the file is absent or has been emptied. A
   *  blank file is treated as absent: an empty secret authenticates nothing, so leaving it in place
   *  would lock the operator out of their own daemon with no diagnosable cause. */
  private async tokenAt(path: string): Promise<string> {
    if (await this.vetExisting(path)) {
      await this.files.setMode(path, TOKEN_MODE);
      const existing = (await this.files.readText(path))?.trim();
      if (existing !== undefined && existing !== '') return existing;
    }
    const minted = this.mint();
    await this.files.writeTextAtomic(path, `${minted}\n`);
    await this.files.setMode(path, TOKEN_MODE);
    return minted;
  }

  /** Whether a file is there to reuse; throws when what is there must not be. */
  private async vetExisting(path: string): Promise<boolean> {
    let facts: TokenFileFacts;
    try {
      facts = await this.inspect(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (facts.isSymbolicLink() || !facts.isFile()) {
      throw new ApiTokenFileError(`refusing daemon token at ${path}: it is not a regular file`);
    }
    const uid = this.uid();
    if (uid !== undefined && facts.uid !== uid) {
      throw new ApiTokenFileError(`refusing daemon token at ${path}: it is not owned by this account (uid ${uid})`);
    }
    return true;
  }
}
