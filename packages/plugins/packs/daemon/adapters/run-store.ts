import type { StatePort } from '@ferretry/kernel/contract';
import { PACK_RUNS, PackRunFileSchema } from '../../contract/index.ts';
import type { CleanUpRun, CleanUpRunStore } from '../lib/cleanup/service.ts';

const RUN_FILE = 'run.json';
const decoder = new TextDecoder();

/**
 * Clean up runs in `state/packs/runs/*` (an opaque store, one flat name per file: `<id>.<file>`). A run is its
 * `run.json` and the texts that belong to it (the rough prompt, the idea, the inventory it was shown); removing a run
 * removes all of them. Nothing here reads a path outside the state home: the builder ferret is handed text, not a path.
 */
export class StateCleanUpRunStore implements CleanUpRunStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'list' | 'remove'>) {}

  private name(id: string, file: string): string {
    return `${id}.${file}`;
  }

  async save(run: CleanUpRun): Promise<void> {
    await this.state.write(PACK_RUNS, JSON.stringify({ format: 1, ...run }), this.name(run.job.id, RUN_FILE));
  }

  async load(id: string): Promise<CleanUpRun | undefined> {
    const text = await this.readFile(id, RUN_FILE);
    if (text === undefined) return undefined;
    try {
      const { format: _format, ...run } = PackRunFileSchema.parse(JSON.parse(text));
      return run;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly CleanUpRun[]> {
    const names = await this.state.list(PACK_RUNS);
    const ids = names.flatMap(name => (name.endsWith(`.${RUN_FILE}`) ? [name.slice(0, -(RUN_FILE.length + 1))] : []));
    const runs = await Promise.all(ids.map(async id => await this.load(id)));
    return runs
      .filter((run): run is CleanUpRun => run !== undefined)
      .sort((a, b) => Date.parse(b.job.startedAt) - Date.parse(a.job.startedAt));
  }

  async remove(id: string): Promise<void> {
    const names = await this.state.list(PACK_RUNS);
    await Promise.all(
      names.filter(name => name.startsWith(`${id}.`)).map(async name => await this.state.remove(PACK_RUNS, name)),
    );
  }

  async writeFile(id: string, file: string, text: string): Promise<void> {
    await this.state.write(PACK_RUNS, text, this.name(id, file));
  }

  async readFile(id: string, file: string): Promise<string | undefined> {
    const read = await this.state.read(PACK_RUNS, this.name(id, file));
    if (!read.ok || read.value === undefined) return undefined;
    const bytes: unknown = read.value;
    return typeof bytes === 'string' ? bytes : decoder.decode(bytes as Uint8Array);
  }
}
