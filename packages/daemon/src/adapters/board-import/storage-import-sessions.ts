import { type TaskAssigneeCandidate, exactWorkerAssignee } from '../../lib/tasks/index.ts';
import type { ImportSessions } from '../../lib/board-import/index.ts';

/** The sessions the daemon holds, and which string names one, by the same rule the task board uses. */
export class StorageImportSessions implements ImportSessions {
  constructor(
    private readonly ids: () => readonly string[],
    private readonly candidates: () => Promise<readonly TaskAssigneeCandidate[]>,
  ) {}

  async list(): Promise<readonly string[]> {
    return this.ids();
  }

  async exists(value: string): Promise<boolean> {
    return this.ids().includes(value);
  }

  async resolveAssignee(assignee: string): Promise<string | null> {
    return exactWorkerAssignee({ assignee }, await this.candidates());
  }
}
