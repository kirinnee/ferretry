import { z } from 'zod';
import type { MachineMembersStore } from '../../lib/agenda/index.ts';
import type { FileSystemPort } from '../../lib/ports.ts';

const MembersSchema = z.record(z.string(), z.array(z.string()));

/** What each machine-agenda cause listed last, as one small JSON file. An unreadable file is an empty record. */
export class FileMachineMembers implements MachineMembersStore {
  constructor(
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic'>,
    private readonly path: string,
  ) {}

  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    const text = await this.files.readText(this.path).catch(() => undefined);
    if (text === undefined) return {};
    try {
      const parsed = MembersSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(members, null, 2)}\n`);
  }
}
