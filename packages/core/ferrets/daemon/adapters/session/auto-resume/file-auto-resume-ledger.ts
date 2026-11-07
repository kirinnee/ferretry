import type { FileSystemPort } from '../../../lib/ports.ts';
import {
  type AutoResumeCandidate,
  type AutoResumeLedgerPort,
  AutoResumeLedgerSchema,
} from '../../../lib/session/auto-resume/types.ts';

/**
 * The sessions still owed an auto-resume, kept in the state home so a second power cut mid-pass
 * does not forget them.
 *
 * AN UNREADABLE FILE READS AS EMPTY, which is the safe direction here and the opposite of the
 * self-restart stamp: forgetting a candidate costs a session staying down until a person revives it,
 * while believing a torn file could revive sessions nobody asked to bring back. An empty list is
 * written as no file at all.
 */
export class FileAutoResumeLedger implements AutoResumeLedgerPort {
  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly file: string,
  ) {}

  async read(): Promise<readonly AutoResumeCandidate[]> {
    const text = await this.fileSystem.readText(this.file).catch(() => undefined);
    if (text === undefined) return [];
    try {
      const parsed = AutoResumeLedgerSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.candidates : [];
    } catch {
      return [];
    }
  }

  async write(candidates: readonly AutoResumeCandidate[]): Promise<void> {
    if (candidates.length === 0) {
      await this.fileSystem.removeFile(this.file);
      return;
    }
    await this.fileSystem.writeTextAtomic(this.file, `${JSON.stringify({ version: 1, candidates }, undefined, 2)}\n`);
  }
}
