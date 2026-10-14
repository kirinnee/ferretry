import { constants } from 'node:fs';
import { chmod, type FileHandle, lstat, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AuditRecord, AuditRecordSchema } from '@ferretry/protocol';
import type { AuditJournalPort, AuditReading, AuditRotation, AuditStore } from '../../lib/index.ts';

/** Each live file's bound. A line that would carry it past this rotates first. */
export const AUDIT_FILE_MAX_BYTES = 1024 * 1024;

interface StorePaths {
  readonly live: string;
  readonly rotated: string;
}

/**
 * `<state>/audit.jsonl` and its rotated file — the GENERAL store — plus `audit-kept.jsonl` and its
 * rotated file, the store a flood cannot reach. See {@link AuditStore}.
 */
export function auditJournalPaths(state: string): StorePaths & { readonly kept: StorePaths } {
  return {
    live: join(state, 'audit.jsonl'),
    rotated: join(state, 'audit.1.jsonl'),
    kept: { live: join(state, 'audit-kept.jsonl'), rotated: join(state, 'audit-kept.1.jsonl') },
  };
}

/**
 * The security log on disk: two STORES of two files each, at most a mebibyte a file, never rewritten
 * in place.
 *
 * ## TWO STORES, SO A FLOOD CANNOT ERASE WHAT MATTERS
 *
 * The `kept` store holds only the successes a reader must never lose (see `AuditLog.record`); the
 * `general` store holds everything else, every refusal and all activity included. Each rotates on its
 * own, so filling `general` — with refusals, or with attaches a paired device repeats at will — leaves
 * every pairing, revocation and grant change in `kept` where it was. `recent` reads all four files
 * and returns the two stores APART, so neither can push the other off a reader's page.
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
 * renamed over its rotated file and a new one is started — unless the append said `never`, which is
 * how a paired device's kept record is written: then a full store refuses the line instead. Rename is the only way a record leaves, and
 * it takes a whole file at a time, so nothing is ever edited — four files, four mebibytes total.
 *
 * ## OWNER-ONLY, AND NEVER THROUGH A LINK
 *
 * Created `0600` and re-`chmod`ed on every write, so a file somebody loosened is tightened again by
 * the next record. `O_NOFOLLOW` refuses a symbolic link planted at the path: the state home allows
 * none, and a link here would redirect the log into a file the attacker can read.
 *
 * ## NEVER A FIFO, A DEVICE OR A HARD LINK
 *
 * Every open is `O_NONBLOCK` and is followed by an `fstat` of the handle it got: anything but a
 * regular file with exactly one link is refused. A FIFO planted at the path would otherwise block the
 * open forever — and every audited request waits on the write chain — and a second hard link would
 * mirror the log into a file somebody else can read.
 */
export class FileAuditJournal implements AuditJournalPort {
  readonly #stores: Readonly<Record<AuditStore, StorePaths>>;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    state: string,
    private readonly maxBytes: number = AUDIT_FILE_MAX_BYTES,
  ) {
    const paths = auditJournalPaths(state);
    this.#stores = { general: { live: paths.live, rotated: paths.rotated }, kept: paths.kept };
  }

  /**
   * Appends one line, rotating first when it would not fit.
   *
   * Serialised in this process so the size check and the write that follows it are not split by
   * another record — two records each deciding "it still fits" is how a bound is overrun by one line.
   */
  async append(line: string, store: AuditStore, rotation: AuditRotation = 'rotate'): Promise<boolean> {
    const write = this.#writes.then(async () => await this.#append(line, this.#stores[store], rotation));
    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    return await write;
  }

  async #append(line: string, paths: StorePaths, rotation: AuditRotation): Promise<boolean> {
    const encoded = Buffer.from(`${line}\n`, 'utf8');
    const size = await this.#size(paths.live);
    if (size > 0 && size + encoded.byteLength > this.maxBytes) {
      if (rotation === 'never') return false;
      await rename(paths.live, paths.rotated);
    }
    const handle = await open(
      paths.live,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      await assertPlainFile(handle);
      await handle.write(encoded);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(dirname(paths.live), 0o700).catch(() => undefined);
    return true;
  }

  /**
   * The newest general records, a page of the kept records, and every line that could not be read.
   *
   * Each file is bounded, so reading them whole is reading at most four mebibytes. Each store is
   * newest-first by construction. The unreadable count covers EVERY file whatever `limit` is: damage
   * in the history is a fact about the history, not about the page a caller happened to ask for.
   */
  async recent(limit: number, keptOffset: number): Promise<AuditReading> {
    const kept = await this.#store(this.#stores.kept);
    const general = await this.#store(this.#stores.general);
    return {
      records: general.records.slice(0, limit),
      kept: kept.records.slice(keptOffset, keptOffset + limit),
      keptTotal: kept.records.length,
      unreadable: kept.unreadable + general.unreadable,
    };
  }

  async #store(paths: StorePaths): Promise<{ readonly records: AuditRecord[]; readonly unreadable: number }> {
    const live = parsed(await this.#text(paths.live));
    const rotated = parsed(await this.#text(paths.rotated));
    return {
      records: [...live.records.reverse(), ...rotated.records.reverse()],
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
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        await assertPlainFile(handle);
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

/** Refuses a handle that is not one regular file with one name. */
async function assertPlainFile(handle: FileHandle): Promise<void> {
  const facts = await handle.stat();
  if (!facts.isFile()) throw new Error('the security log path is not a regular file');
  if (facts.nlink > 1) throw new Error('the security log file has a second hard link');
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
