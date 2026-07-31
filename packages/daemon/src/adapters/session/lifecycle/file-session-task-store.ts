import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionId } from '../../../lib/index.ts';
import type { SessionTaskStore } from '../../../lib/session/lifecycle/index.ts';

/**
 * Turn-one storage inside the session's own private directory. The write is atomic and repeatable:
 * a retried launch must be able to re-deliver the same assignment.
 */
export class FileSessionTaskStore implements SessionTaskStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'turns', 'turn-001.md');
  }

  async writeAssignedTask(id: SessionId, document: string): Promise<string> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    return file;
  }
}
