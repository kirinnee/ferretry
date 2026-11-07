import type { Log, StatePort } from '@ferretry/kernel/contract';
import { type UpdateCheck, UPDATES_LATEST, UPDATES_REPORT, type UpdateReport } from '../../contract/index.ts';
import type { UpdateDocuments } from '../lib/ports.ts';

/**
 * The update's documents, inside this plugin's state folder: the last check, and the report the update leaves when it
 * finishes. A damaged file reads as absent (the worst it can do is ask GitHub again) and is said once in the log.
 */
export class StateUpdateDocuments implements UpdateDocuments {
  constructor(
    private readonly state: StatePort,
    private readonly log: Log,
  ) {}

  async readLatest(): Promise<UpdateCheck | undefined> {
    return await this.#read(UPDATES_LATEST);
  }

  async writeLatest(check: UpdateCheck): Promise<void> {
    await this.state.write(UPDATES_LATEST, check);
  }

  async readReport(): Promise<UpdateReport | undefined> {
    return await this.#read(UPDATES_REPORT);
  }

  async removeReport(): Promise<void> {
    await this.state.remove(UPDATES_REPORT);
  }

  async #read<Shape>(
    file: Parameters<StatePort['read']>[0] & { readonly schema?: unknown },
  ): Promise<Shape | undefined> {
    const read = await this.state.read(file);
    if (!read.ok) {
      this.log.warn('an update document could not be read; treating it as never written', { file: read.error.file });
      return undefined;
    }
    return read.value as Shape | undefined;
  }
}
