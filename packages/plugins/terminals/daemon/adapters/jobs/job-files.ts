import { type FileHandle, open, readFile, stat } from '../host/fs.ts';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { JobExitSchema, type JobExit, type JobMeta, JobMetaSchema } from '../../../contract/index.ts';
import type { JobFilesPort, TrackedProcess } from '../../lib/jobs/contracts.ts';

const JOB_FILES = ['job.json', 'exit.json', 'exit.json.tmp', 'stop', 'tracked', 'output.log', 'reported'] as const;
const ID = /^[a-f0-9]{12}$/u;

/**
 * A job's folder is `<state>/jobs/<ferret>/<job>/`, an opaque named tree the kernel's state port owns: it makes the private
 * folders and writes `job.json` atomically, and hands the folder's path to the one process that writes into it itself — the
 * wrapper in the pane (`output.log`, `exit.json`). The daemon reads those two files with plain reads: it never appends.
 */
export class StateJobFiles implements JobFilesPort {
  constructor(
    private readonly state: Pick<
      StatePort,
      'write' | 'pathOf' | 'list' | 'entries' | 'remove' | 'removeEmptyDirectory' | 'createPrivateDirectory'
    >,
    private readonly tree: StateFileDef,
  ) {}

  private name(owner: string, id: string, file?: string): string {
    return file === undefined ? `${owner}/${id}` : `${owner}/${id}/${file}`;
  }

  private path(owner: string, id: string, file: string): string {
    return this.state.pathOf(this.tree, this.name(owner, id, file));
  }

  async create(owner: string, id: string): Promise<string> {
    await this.state.createPrivateDirectory(this.tree, owner).catch(() => undefined); // the ferret's folder may exist
    await this.state.createPrivateDirectory(this.tree, this.name(owner, id));
    return this.state.pathOf(this.tree, this.name(owner, id));
  }

  async writeMeta(owner: string, id: string, meta: JobMeta): Promise<void> {
    await this.state.write(this.tree, `${JSON.stringify(meta)}\n` as never, this.name(owner, id, 'job.json'));
  }

  async readMeta(owner: string, id: string): Promise<JobMeta | undefined> {
    return await this.readJson(this.path(owner, id, 'job.json'), JobMetaSchema);
  }

  async readExit(owner: string, id: string): Promise<JobExit | undefined> {
    return await this.readJson(this.path(owner, id, 'exit.json'), JobExitSchema);
  }

  async writeExit(owner: string, id: string, exit: JobExit): Promise<void> {
    await this.state.write(this.tree, `${JSON.stringify(exit)}\n` as never, this.name(owner, id, 'exit.json'));
  }

  private async readJson<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async readTracked(owner: string, id: string): Promise<readonly TrackedProcess[]> {
    let text: string;
    try {
      text = await readFile(this.path(owner, id, 'tracked'), 'utf8');
    } catch {
      return [];
    }
    const found: TrackedProcess[] = [];
    for (const line of text.split('\n')) {
      const match = /^(\d+)=(\S+)$/u.exec(line);
      if (match !== null) found.push({ pid: Number(match[1]), start: match[2] ?? '' });
    }
    return found;
  }

  async isReported(owner: string, id: string): Promise<boolean> {
    try {
      await stat(this.path(owner, id, 'reported'));
      return true;
    } catch {
      return false;
    }
  }

  async markReported(owner: string, id: string): Promise<void> {
    await this.state.write(this.tree, '' as never, this.name(owner, id, 'reported'));
  }

  async requestStop(owner: string, id: string): Promise<void> {
    await this.state.write(this.tree, '' as never, this.name(owner, id, 'stop'));
  }

  async outputSize(owner: string, id: string): Promise<number> {
    try {
      return (await stat(this.path(owner, id, 'output.log'))).size;
    } catch {
      return 0;
    }
  }

  async readOutput(owner: string, id: string, from: number, max: number): Promise<Uint8Array> {
    if (max <= 0) return new Uint8Array();
    let handle: FileHandle;
    try {
      handle = await open(this.path(owner, id, 'output.log'), 'r');
    } catch {
      return new Uint8Array();
    }
    try {
      const buffer = new Uint8Array(max);
      const { bytesRead } = await handle.read(buffer, 0, max, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async list(): Promise<readonly { readonly owner: string; readonly id: string }[]> {
    const found: { owner: string; id: string }[] = [];
    for (const owner of await this.state.list(this.tree)) {
      for (const entry of await this.state.entries(this.tree, owner))
        if (entry.kind === 'directory' && ID.test(entry.name)) found.push({ owner, id: entry.name });
    }
    return found;
  }

  async remove(owner: string, id: string): Promise<void> {
    for (const file of JOB_FILES) await this.state.remove(this.tree, this.name(owner, id, file)).catch(() => undefined);
    await this.state.removeEmptyDirectory(this.tree, this.name(owner, id)).catch(() => undefined);
    if ((await this.state.entries(this.tree, owner)).length === 0)
      await this.state.removeEmptyDirectory(this.tree, owner).catch(() => undefined);
  }
}
