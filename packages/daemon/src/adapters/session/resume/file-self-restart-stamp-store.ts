import type { FileSystemPort } from '../../../lib/ports.ts';
import {
  type SelfRestartStamp,
  SelfRestartStampSchema,
  type SelfRestartStampStore,
} from '../../../lib/session/health/types.ts';

/**
 * The self-restart cooldown, kept in the state home so it survives the restart it records.
 *
 * A read that fails THROWS rather than answering "no stamp". The distinction is the whole guard: a
 * stamp file that exists but will not parse is the signature of a daemon that keeps restarting, and
 * reading it as an absent stamp — which the ancestor did — grants the very restart the cooldown
 * exists to withhold. An absent file is the only thing that means "nothing has restarted".
 */
export class FileSelfRestartStampStore implements SelfRestartStampStore {
  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly file: string,
  ) {}

  async read(): Promise<SelfRestartStamp | undefined> {
    const text = await this.fileSystem.readText(this.file);
    if (text === undefined) return undefined;
    return SelfRestartStampSchema.parse(JSON.parse(text));
  }

  async write(stamp: SelfRestartStamp): Promise<void> {
    // Atomic: a torn stamp reads as unparseable, which suppresses restarts until a human looks.
    await this.fileSystem.writeTextAtomic(this.file, `${JSON.stringify(stamp, undefined, 2)}\n`);
  }

  async clear(): Promise<void> {
    await this.fileSystem.removeFile(this.file);
  }
}
