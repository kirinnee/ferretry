import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AuditRecord, AuditRecordSchema } from '@ferretry/protocol';
import type { AuditJournalPort, AuditReading } from '../../lib/index.ts';

/** The live file's bound. A line that would carry it past this rotates first. */
export const AUDIT_FILE_MAX_BYTES = 1024 * 1024;

/** `<state>/audit.jsonl` and the one rotated file beside it. */
export function auditJournalPaths(state: string): { readonly live: string; readonly rotated: string } {
  return { live: join(state, 'audit.jsonl'), rotated: join(state, 'audit.1.jsonl') };
}

/**
 * The security log on disk: two files, at most a mebibyte each, never rewritten in place.
 *
 * ## ONE `O_APPEND` WRITE PER RECORD
 *
 * Each record is opened with `O_APPEND`, written in ONE `write` of the whole line including its
 * newline, synced, and closed. The kernel places an `O_APPEND` write at the end atomically, so two
 * writers can interleave records but never bytes inside one — and a crash mid-write leaves at worst
 * one truncated last line, which the reader counts as unreadable rather than hiding.
 *
 * ## BOUNDED BY ROTATION, NOT BY TRUNCATION
 *
 * When the next line would carry the live file past {@link AUDIT_FILE_MAX_BYTES}, the live file is
 * renamed over `audit.1.jsonl` and a new one is started. Rename is the only way a record leaves, and
 * it takes a whole file at a time, so nothing is ever edited — two files kept, two mebibytes total.
 *
 * ## OWNER-ONLY, AND NEVER THROUGH A LINK
 *
 * Created `0600` and re-`chmod`ed on every write, so a file somebody loosened is tightened again by
 * the next record. `O_NOFOLLOW` refuses a symbolic link planted at the path: the state home allows
 * none, and a link here would redirect the log into a file the attacker can read.
 */
export class FileAuditJournal implements AuditJournalPort {
  readonly #live: string;
  readonly #rotated: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    state: string,
    private readonly maxBytes: number = AUDIT_FILE_MAX_BYTES,
  ) {
    const paths = auditJournalPaths(state);
    this.#live = paths.live;
    this.#rotated = paths.rotated;
  }

  /**
   * Appends one line, rotating first when it would not fit.
   *
   * Serialised in this process so the size check and the write that follows it are not split by
   * another record — two records each deciding "it still fits" is how a bound is overrun by one line.
   */
  async append(line: string): Promise<void> {
    const write = this.#writes.then(async () => await this.#append(line));
    this.#writes = write.catch(() => undefined);
    await write;
  }

  async #append(line: string): Promise<void> {
    const encoded = Buffer.from(`${line}\n`, 'utf8');
    const size = await this.#size(this.#live);
    if (size > 0 && size + encoded.byteLength > this.maxBytes) await rename(this.#live, this.#rotated);
    const handle = await open(
      this.#live,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.write(encoded);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(dirname(this.#live), 0o700).catch(() => undefined);
  }

  /**
   * The newest records across both files, and every line that could not be read.
   *
   * Both files are bounded, so reading them whole is reading at most two mebibytes. The unreadable
   * count covers BOTH files whatever `limit` is: damage in the history is a fact about the history,
   * not about the page a caller happened to ask for.
   */
  async recent(limit: number): Promise<AuditReading> {
    const live = parsed(await this.#text(this.#live));
    const rotated = parsed(await this.#text(this.#rotated));
    return {
      records: [...live.records.reverse(), ...rotated.records.reverse()].slice(0, limit),
      unreadable: live.unreadable + rotated.unreadable,
    };
  }

  async #size(path: string): Promise<number> {
    try {
      return (await lstat(path)).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async #text(path: string): Promise<string> {
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await readFile(handle, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) return '';
      throw error;
    }
  }
}

/** Every record in one file, oldest first, and the count of lines that are not one. */
function parsed(text: string): { readonly records: AuditRecord[]; readonly unreadable: number } {
  const records: AuditRecord[] = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = readLine(line);
    if (record === undefined) unreadable += 1;
    else records.push(record);
  }
  return { records, unreadable };
}

function readLine(line: string): AuditRecord | undefined {
  try {
    const result = AuditRecordSchema.safeParse(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
