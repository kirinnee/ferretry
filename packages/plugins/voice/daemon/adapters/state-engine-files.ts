import { dirname } from 'node:path';
import type { HostFactsPort, StatePort } from '@ferretry/kernel/contract';
import { MODELS_STATE } from '../../contract/index.ts';
import { ENGINE_DIR, type EngineFile } from '../lib/engine/catalog.ts';
import type { EnginePathsPort } from '../lib/engine/ports.ts';

/**
 * The engine's downloaded files, in `state/voice/models/<ENGINE_DIR>/<role>`. A file is written whole and atomically
 * AFTER its hash was checked, so a file that is present at its pinned size is a verified one.
 */
export class StateEngineFiles implements EnginePathsPort {
  constructor(
    private readonly state: StatePort,
    private readonly host: Pick<HostFactsPort, 'diskFreeBytes'>,
    /** The folder under `models/` these files live in: the speech engine's by default, the reply voice's by name. */
    private readonly dir: string = ENGINE_DIR,
  ) {}

  pathOf(file: Pick<EngineFile, 'role'>): string {
    return this.state.pathOf(MODELS_STATE, this.name(file));
  }

  private name(file: Pick<EngineFile, 'role'>): string {
    return `${this.dir}/${file.role}`;
  }

  async size(file: Pick<EngineFile, 'role'>): Promise<number | undefined> {
    return (await this.state.version(MODELS_STATE, this.name(file)))?.size;
  }

  async read(file: Pick<EngineFile, 'role'>): Promise<Uint8Array | undefined> {
    const read = await this.state.read(MODELS_STATE, this.name(file));
    return read.ok ? (read.value as Uint8Array | undefined) : undefined;
  }

  async write(file: Pick<EngineFile, 'role'>, bytes: Uint8Array): Promise<void> {
    await this.state.write(MODELS_STATE, bytes, this.name(file));
  }

  async remove(file: Pick<EngineFile, 'role'>): Promise<void> {
    await this.state.remove(MODELS_STATE, this.name(file));
  }

  /**
   * What the disk holding the models folder has free. The nearest folder above it that exists is asked (a first
   * install has none yet). A host that cannot say, or refuses, is "cannot say": Install is not blocked on a guess.
   */
  async freeBytes(): Promise<number | undefined> {
    let folder = dirname(this.state.pathOf(MODELS_STATE, `${this.dir}/free-space-probe`));
    try {
      for (;;) {
        const free = await this.host.diskFreeBytes(folder);
        if (free !== undefined) return free;
        const parent = dirname(folder);
        if (parent === folder) return undefined;
        folder = parent;
      }
    } catch {
      return undefined;
    }
  }
}
