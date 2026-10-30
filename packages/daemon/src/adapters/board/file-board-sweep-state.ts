import { join } from 'node:path';
import { InstantSchema } from '@ferretry/protocol';
import { z } from 'zod';
import {
  type BoardDiagnostics,
  EMPTY_SWEEP_MEMORY,
  mergeQuietItems,
  type PendingContextQueue,
  type QuietItem,
  type SweepMemory,
  SweepMemorySchema,
  type SweepMemoryStore,
} from '../../lib/board/index.ts';
import type { FileSystemPort, SerialExecutor } from '../../lib/index.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';

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

const QuietItemSchema = z.strictObject({
  key: z.string().min(1).max(64),
  text: z.string().min(1).max(512),
  at: InstantSchema,
});
const PendingFileSchema = z.strictObject({ v: z.literal(1), items: z.array(QuietItemSchema) });

/**
 * Each ferret's pending context, one small file per session, `<board>/pending/<sessionId>.json`, written
 * atomically and serialized per session, so the sweep appending and a send taking never interleave. A
 * damaged file reads as empty (and is reported), because what it held was only ever news. An id that is
 * not a session id names no file and holds nothing.
 */
export class FilePendingContext implements PendingContextQueue {
  private readonly directory: string;

  constructor(
    directory: string,
    private readonly files: FileSystemPort,
    private readonly serial: SerialExecutor,
    private readonly diagnostics: BoardDiagnostics,
  ) {
    this.directory = join(directory, 'pending');
  }

  async append(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    await this.update(sessionId, held => mergeQuietItems(held, items));
  }

  async take(sessionId: string): Promise<readonly QuietItem[]> {
    let taken: readonly QuietItem[] = [];
    await this.update(sessionId, held => {
      taken = held;
      return [];
    });
    return taken;
  }

  async restore(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    await this.update(sessionId, held => mergeQuietItems(items, held));
  }

  private async update(sessionId: string, change: (held: readonly QuietItem[]) => readonly QuietItem[]): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    const file = join(this.directory, `${id}.json`);
    await this.serial.run(`board:pending:${id}`, async () => {
      const text = await this.files.readText(file);
      const document = parsed(PendingFileSchema, text);
      if (document === null) this.diagnostics.warn(`the board's pending context for ${id} is damaged; dropping it`);
      const held = document?.items ?? [];
      const next = change(held);
      // Nothing held and nothing to hold: a missing or empty file stays as it is.
      if (next.length === 0 && held.length === 0 && document !== null) return;
      await this.files.writeTextAtomic(file, `${JSON.stringify({ v: 1, items: next })}\n`);
    });
  }
}
