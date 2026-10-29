import { readdir, stat } from 'node:fs/promises';
// The describer's own module, never `conversations.ts`: this file is loaded by the transcript worker, and
// the service module carries the adoption schemas, whose protocol import is ~70 MB the worker never uses.
import type {
  ConversationFileEntry,
  ConversationFileInfo,
  ConversationFiles,
} from '../../lib/imports/conversation-describer.ts';

/** The read-only file port conversation discovery uses. A link is never followed. */
export class NodeConversationFiles implements ConversationFiles {
  async entries(directory: string): Promise<readonly ConversationFileEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.map(entry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }));
  }

  async info(file: string): Promise<ConversationFileInfo | undefined> {
    const details = await stat(file).catch(() => undefined);
    return details?.isFile() === true ? { modifiedAtMs: details.mtimeMs, size: details.size } : undefined;
  }

  async tail(file: string, maxBytes: number): Promise<string | undefined> {
    const details = await this.info(file);
    if (details === undefined) return undefined;
    return await Bun.file(file)
      .slice(Math.max(0, details.size - maxBytes), details.size)
      .text()
      .catch(() => undefined);
  }

  async head(file: string, maxBytes: number): Promise<string | undefined> {
    if ((await this.info(file)) === undefined) return undefined;
    return await Bun.file(file)
      .slice(0, maxBytes)
      .text()
      .catch(() => undefined);
  }
}
