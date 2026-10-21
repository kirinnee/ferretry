import { type AutoResumeSummary, AutoResumeSummarySchema } from '@ferretry/protocol';
import type { FileSystemPort } from '../../../lib/ports.ts';

/** What the last auto-resume pass did, kept so the app can still say so after a daemon restart. */
export class FileAutoResumeSummaryStore {
  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly file: string,
  ) {}

  async read(): Promise<AutoResumeSummary | null> {
    const text = await this.fileSystem.readText(this.file).catch(() => undefined);
    if (text === undefined) return null;
    try {
      const parsed = AutoResumeSummarySchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(summary: AutoResumeSummary): Promise<void> {
    await this.fileSystem.writeTextAtomic(this.file, `${JSON.stringify(summary, undefined, 2)}\n`);
  }
}
