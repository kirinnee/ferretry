import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WardenJevCheck } from '@ferretry/protocol';
import {
  expiredJevCheckFiles,
  jevCheckFileName,
  jevCheckFilesNewestFirst,
  jevCheckDay,
  jevCheckLine,
  parseJevCheckLines,
  type WardenJevCheckLog,
} from '../../lib/warden/index.ts';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Jev's checks on disk, beside the Warden's reports: `warden/jev-checks/<UTC day>.jsonl`, one JSON line per
 * check, appended (`lib/warden/jev-checks.ts` owns what a line says and how long a day is kept).
 *
 * Owner-only, like everything in the Warden's directory. Every append drops the days past the keep window,
 * so the record is bounded without a timer of its own; a directory of at most a month of files is cheap
 * to list. A line is small and written by one `appendFile`, so a torn line is at worst one check lost —
 * which the reader skips.
 */
export class FileWardenJevCheckLog implements WardenJevCheckLog {
  constructor(
    private readonly directory: string,
    private readonly nowMs: () => number,
  ) {}

  async append(check: WardenJevCheck): Promise<void> {
    const day = jevCheckDay(check) ?? new Date(this.nowMs()).toISOString().slice(0, 10);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(join(this.directory, jevCheckFileName(day)), jevCheckLine(check), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const expired = expiredJevCheckFiles(await this.names(), this.nowMs());
    await Promise.all(expired.map(name => rm(join(this.directory, name), { force: true })));
  }

  async recent(limit: number): Promise<readonly WardenJevCheck[]> {
    const checks: WardenJevCheck[] = [];
    for (const name of jevCheckFilesNewestFirst(await this.names())) {
      if (checks.length >= limit) break;
      const text = await readFile(join(this.directory, name), 'utf8').catch((error: unknown) => {
        // Rotated away between the listing and the read: that day simply has nothing left to show.
        if (isMissing(error)) return '';
        throw error;
      });
      checks.push(...parseJevCheckLines(text));
    }
    return checks.slice(0, limit);
  }

  private async names(): Promise<readonly string[]> {
    try {
      return await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
