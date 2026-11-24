import type { StatePort } from '@ferretry/kernel/contract';
import { MODELS_STATE } from '../../contract/index.ts';
import { ENGINE_DIR, type EngineFile } from '../lib/engine/catalog.ts';
import type { EngineFilesPort } from '../lib/engine/ports.ts';

/**
 * The engine's downloaded files, in `state/voice/models/<ENGINE_DIR>/<role>`. A file is written whole and atomically
 * AFTER its hash was checked, so a file that is present at its pinned size is a verified one.
 */
export class StateEngineFiles implements EngineFilesPort {
  constructor(private readonly state: StatePort) {}

  private name(file: Pick<EngineFile, 'role'>): string {
    return `${ENGINE_DIR}/${file.role}`;
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
}
