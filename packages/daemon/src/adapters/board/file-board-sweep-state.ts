import { join } from 'node:path';
import type { z } from 'zod';
import {
  type BoardDiagnostics,
  EMPTY_SWEEP_MEMORY,
  type SweepMemory,
  SweepMemorySchema,
  type SweepMemoryStore,
} from '../../lib/board/index.ts';
import type { FileSystemPort } from '../../lib/index.ts';

const parsed = <T>(schema: z.ZodType<T>, text: string | undefined): T | undefined | null => {
  if (text === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/**
 * The board sweep's memory, `<board>/sweep.json`: what the last tick saw and when each card was nudged.
 * Written atomically. Damage reads as a fresh start — every card a baseline again, no nudge remembered —
 * and is reported once per read: losing it costs at most one early nudge per stale card.
 */
export class FileSweepMemory implements SweepMemoryStore {
  private readonly file: string;

  constructor(
    directory: string,
    private readonly files: FileSystemPort,
    private readonly diagnostics: BoardDiagnostics,
  ) {
    this.file = join(directory, 'sweep.json');
  }

  async read(): Promise<SweepMemory> {
    const memory = parsed(SweepMemorySchema, await this.files.readText(this.file));
    if (memory === null) this.diagnostics.warn('the board sweep memory is damaged; starting it again');
    return memory ?? EMPTY_SWEEP_MEMORY;
  }

  async write(memory: SweepMemory): Promise<void> {
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(SweepMemorySchema.parse(memory))}\n`);
  }
}
