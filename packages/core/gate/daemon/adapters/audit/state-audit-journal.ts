import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { AuditRecord } from '../../../contract/index.ts';
import type { AuditJournalPort, AuditReading, AuditRotation, AuditStore } from '../../lib/audit/service.ts';

/** Each live file's bound (today's `AUDIT_FILE_MAX_BYTES`). A line that would carry it past this rotates first. */
export const AUDIT_FILE_MAX_BYTES = 1024 * 1024;

/** The four files: each store's live file and its rotated one (`audit.jsonl`, `audit.1.jsonl`, `audit-kept…`). */
export interface AuditFiles {
  readonly general: {
    readonly live: StateFileDef<string, AuditRecord>;
    readonly rotated: StateFileDef<string, AuditRecord>;
  };
  readonly kept: {
    readonly live: StateFileDef<string, AuditRecord>;
    readonly rotated: StateFileDef<string, AuditRecord>;
  };
}

const lineBytes = (record: AuditRecord): number => new TextEncoder().encode(`${JSON.stringify(record)}\n`).byteLength;

/**
 * The audit on disk (today's `FileAuditJournal`), through the kernel's state port: two STORES of two files
 * each, at most a mebibyte a file, never rewritten in place. The kernel's port appends one line at a time on one
 * serialization chain per file and keeps the files `0600`; links, FIFOs and device files are the kernel's to refuse.
 *
 * Rotation moves the live file's records to the rotated file (whose old records go) and starts a new live file:
 * the port has no rename, so the move is a copy then a remove, serialised here with every other write.
 */
export class StateAuditJournal implements AuditJournalPort {
  readonly #sizes = new Map<AuditStore, number>();
  #writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: StatePort,
    private readonly files: AuditFiles,
    private readonly maxBytes: number = AUDIT_FILE_MAX_BYTES,
  ) {}

  async append(record: AuditRecord, store: AuditStore, rotation: AuditRotation = 'rotate'): Promise<boolean> {
    const write = this.#writes.then(async () => await this.#append(record, store, rotation));
    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    return await write;
  }

  async #append(record: AuditRecord, store: AuditStore, rotation: AuditRotation): Promise<boolean> {
    const files = this.files[store];
    const encoded = lineBytes(record);
    const size = await this.#size(store);
    if (size > 0 && size + encoded > this.maxBytes) {
      if (rotation === 'never') return false;
      await this.#rotate(store);
    }
    await this.state.append(files.live, record);
    this.#sizes.set(store, (this.#sizes.get(store) ?? 0) + encoded);
    return true;
  }

  async #rotate(store: AuditStore): Promise<void> {
    const files = this.files[store];
    const live = await this.#read(files.live);
    await this.state.remove(files.rotated);
    for (const record of live.records) await this.state.append(files.rotated, record);
    await this.state.remove(files.live);
    this.#sizes.set(store, 0);
  }

  /** The live file's size on disk, from one `lstat` (the kernel's `version`), remembered between writes. */
  async #size(store: AuditStore): Promise<number> {
    const known = this.#sizes.get(store);
    if (known !== undefined) return known;
    const size = (await this.state.version(this.files[store].live))?.size ?? 0;
    this.#sizes.set(store, size);
    return size;
  }

  /**
   * Every record of one file, oldest first (today's `FileAuditJournal.parsed`): each line is checked on its own, so a
   * damaged line is COUNTED and the valid records around it are still read. A file the kernel could not read at all is
   * one unreadable count rather than an empty history.
   */
  async #read(
    file: StateFileDef<string, AuditRecord>,
  ): Promise<{ readonly records: AuditRecord[]; readonly unreadable: number }> {
    try {
      const read = await this.state.records(file);
      return { records: [...read.records], unreadable: read.unreadable };
    } catch {
      return { records: [], unreadable: 1 };
    }
  }

  /** The newest general records, a page of the kept records, and what could not be read (today's `recent`). */
  async recent(limit: number, keptOffset: number): Promise<AuditReading> {
    const kept = await this.#store('kept');
    const general = await this.#store('general');
    return {
      records: general.records.slice(0, limit),
      kept: kept.records.slice(keptOffset, keptOffset + limit),
      keptTotal: kept.records.length,
      unreadable: kept.unreadable + general.unreadable,
    };
  }

  async #store(store: AuditStore): Promise<{ readonly records: AuditRecord[]; readonly unreadable: number }> {
    const live = await this.#read(this.files[store].live);
    const rotated = await this.#read(this.files[store].rotated);
    return {
      records: [...live.records.reverse(), ...rotated.records.reverse()],
      unreadable: live.unreadable + rotated.unreadable,
    };
  }
}
