import type { FileSystemPort } from '../../../lib/ports.ts';
import {
  type CompactionHistory,
  type CompactionRecord,
  CompactionRecordSchema,
  type TranscriptHarness,
} from '../../../lib/index.ts';
import { z } from 'zod';

/** Entries kept: enough for a stable median, few enough that the file stays one screenful. */
const KEPT_ENTRIES = 50;
/** How many of the newest matching entries the median is taken over. */
const MEDIAN_WINDOW = 20;
/** A model with fewer watched compactions than this borrows its harness's. */
const MIN_MODEL_ENTRIES = 3;

const DocumentSchema = z.strictObject({ version: z.literal(1), entries: z.array(CompactionRecordSchema) });

/**
 * How long this daemon's compactions have taken, kept in the state home so an estimate survives a restart.
 *
 * A file that is absent or unreadable is an EMPTY history, never an error: the only cost of losing it is
 * that the next estimate says `typical` again. Writes are serialized, so two sessions finishing at once
 * cannot lose one another's entry.
 */
export class FileCompactionHistory implements CompactionHistory {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly file: string,
  ) {}

  async durations(harness: TranscriptHarness, model: string | undefined): Promise<readonly number[]> {
    const entries = (await this.read()).filter(entry => entry.harness === harness);
    const sameModel = model === undefined ? [] : entries.filter(entry => entry.model === model);
    return (sameModel.length >= MIN_MODEL_ENTRIES ? sameModel : entries)
      .slice(-MEDIAN_WINDOW)
      .map(entry => entry.durationMs);
  }

  record(entry: CompactionRecord): Promise<void> {
    const write = this.pending.then(async () => {
      const entries = [...(await this.read()), entry].slice(-KEPT_ENTRIES);
      await this.fileSystem.writeTextAtomic(this.file, `${JSON.stringify({ version: 1, entries })}\n`);
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  private async read(): Promise<readonly CompactionRecord[]> {
    const text = await this.fileSystem.readText(this.file).catch(() => undefined);
    if (text === undefined) return [];
    try {
      const parsed = DocumentSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.entries : [];
    } catch {
      return [];
    }
  }
}
