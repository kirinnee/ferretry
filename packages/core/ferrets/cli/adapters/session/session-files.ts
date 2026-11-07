import { basename } from 'node:path';
import { SessionCommandError } from '../../lib/session/errors.ts';
import type { ISessionFiles } from '../../lib/session/ports.ts';

/** What a file read needs from the runtime, so tests can drive it without a disk. */
export interface IFileSource {
  text(path: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
  mime(path: string): string;
}

/** Bun's file API. The only place the session commands touch the filesystem. */
export class BunFileSource implements IFileSource {
  text(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async bytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }

  mime(path: string): string {
    return Bun.file(path).type;
  }
}

/**
 * Reads the prompts, messages and attachments the session commands accept.
 *
 * An unreadable path is reported as the caller's own mistake naming the path they typed; the source
 * let the runtime's ENOENT stack out, which told a user nothing about which flag was wrong.
 */
export class SessionFiles implements ISessionFiles {
  constructor(private readonly source: IFileSource = new BunFileSource()) {}

  async readText(path: string): Promise<string> {
    try {
      return (await this.source.text(path)).trim();
    } catch (error) {
      throw new SessionCommandError(`cannot read ${path}: ${(error as Error).message}`);
    }
  }

  async readAttachment(path: string): Promise<{ filename: string; mime?: string; base64: string }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.source.bytes(path);
    } catch (error) {
      throw new SessionCommandError(`cannot read attachment ${path}: ${(error as Error).message}`);
    }
    if (bytes.byteLength === 0) throw new SessionCommandError(`attachment ${path} is empty`);
    const mime = this.source.mime(path);
    return {
      filename: basename(path),
      // A document's type is decided by the daemon's extractor; only an image type is worth stating.
      ...(mime.startsWith('image/') ? { mime } : {}),
      base64: Buffer.from(bytes).toString('base64'),
    };
  }
}
