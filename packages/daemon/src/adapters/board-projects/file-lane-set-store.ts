import { join } from 'node:path';
import { type BoardProjectId, type LaneSet, LaneSetSchema } from '@ferretry/protocol';
import type { LaneSetMutation, LaneSetStore } from '../../lib/board-projects/index.ts';
import { TaskStateUnavailableError } from '../../lib/tasks/task-error.ts';
import { AtomicFileWriter } from '../tasks/atomic-file.ts';
import { KeyedSerialExecutor, type SerialExecutor } from '../tasks/serial-executor.ts';

/**
 * One JSON document per project at `<directory>/<projectId>.json`. A project id is a UUID or `unfiled`,
 * never a path, so it cannot escape the directory. A document that does not parse is refused and never
 * overwritten: the evidence stays for an operator, and nobody is told the project has no lanes.
 */
export class FileLaneSetStore implements LaneSetStore {
  constructor(
    private readonly directory: string,
    private readonly writer: AtomicFileWriter = new AtomicFileWriter(),
    private readonly executor: SerialExecutor = new KeyedSerialExecutor(),
  ) {}

  async read(projectId: BoardProjectId): Promise<LaneSet | null> {
    return await this.load(this.pathOf(projectId));
  }

  async transact<T>(projectId: BoardProjectId, decide: (current: LaneSet | null) => LaneSetMutation<T>): Promise<T> {
    const path = this.pathOf(projectId);
    return await this.executor.run(path, async () => {
      const mutation = decide(await this.load(path));
      if (mutation.next !== undefined) await this.writer.write(path, `${JSON.stringify(mutation.next, null, 2)}\n`);
      return mutation.result;
    });
  }

  private pathOf(projectId: BoardProjectId): string {
    return join(this.directory, `${projectId}.json`);
  }

  private async load(path: string): Promise<LaneSet | null> {
    const text = await this.writer.read(path);
    if (text === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new TaskStateUnavailableError(`refusing to use a damaged lane set at ${path}: not JSON`);
    }
    const parsed = LaneSetSchema.safeParse(value);
    if (!parsed.success) {
      throw new TaskStateUnavailableError(`refusing to use a damaged lane set at ${path}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
