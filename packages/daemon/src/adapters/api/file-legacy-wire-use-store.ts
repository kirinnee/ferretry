import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LegacyWireUseSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { LegacyWireDiagnostics, LegacyWireTimers, LegacyWireUseStore } from '../../lib/legacy-wire/index.ts';

const DocumentSchema = z.object({ v: z.literal(1), uses: z.array(LegacyWireUseSchema) });

/**
 * `<daemon home>/legacy-wire-use.json`: the counter of older-wire hits, one small `0600` document.
 *
 * A file that is missing is an empty counter. A file that is unreadable, not JSON or not this shape is
 * said once and treated as empty, so the next save replaces it: the counter is a measurement, never a
 * reason for the daemon to refuse to start or to fail a request.
 */
export class FileLegacyWireUseStore implements LegacyWireUseStore {
  constructor(
    private readonly file: string,
    private readonly diagnostics: LegacyWireDiagnostics,
  ) {}

  async load() {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.#reset(error instanceof Error ? error.message : String(error));
      return [];
    }
    try {
      return DocumentSchema.parse(JSON.parse(text)).uses;
    } catch (error) {
      this.#reset(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  async save(uses: Parameters<LegacyWireUseStore['save']>[0]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ v: 1, uses }, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  #reset(reason: string): void {
    this.diagnostics.warn(`${this.file} could not be read (${reason}); the legacy-wire counter starts again`);
  }
}

/** The counter's clock and timer over the host's. The timer never keeps the process alive. */
export const systemLegacyWireTimers: LegacyWireTimers = {
  now: () => Date.now(),
  after: (delayMs, run) => {
    const handle = setTimeout(run, delayMs);
    handle.unref();
    return () => clearTimeout(handle);
  },
};
