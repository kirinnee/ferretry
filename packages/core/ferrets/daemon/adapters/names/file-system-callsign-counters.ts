import { SYSTEM_CALLSIGN_MAX_SEQUENCE, SYSTEM_CALLSIGN_PREFIXES } from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort } from '../../lib/index.ts';
import type { SystemCallsignCounters, SystemCallsignCounterStore } from '../../lib/names/index.ts';

/**
 * The system-callsign counters, as one small JSON document in the state home: `{"learning":3,"pack":1}`.
 *
 * READING IS TOTAL. A missing or damaged document means "nothing issued yet": the counter only decides
 * where to start looking, and the fleet's own held names (not this file) are what keep an issued id
 * unique, so a lost counter costs a few skipped-over ids and never a collision. WRITING IS ATOMIC, so a
 * crash cannot leave half a document.
 */
const sequence = z.number().int().min(0).max(SYSTEM_CALLSIGN_MAX_SEQUENCE);

export class FileSystemCallsignCounters implements SystemCallsignCounterStore {
  constructor(
    private readonly file: string,
    private readonly files: FileSystemPort,
  ) {}

  async read(): Promise<SystemCallsignCounters> {
    const text = await this.files.readText(this.file).catch(() => undefined);
    if (text === undefined) return {};
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return {};
    }
    if (typeof decoded !== 'object' || decoded === null) return {};
    const counters: SystemCallsignCounters = {};
    for (const prefix of SYSTEM_CALLSIGN_PREFIXES) {
      const parsed = sequence.safeParse((decoded as Record<string, unknown>)[prefix]);
      if (parsed.success) counters[prefix] = parsed.data;
    }
    return counters;
  }

  async write(counters: SystemCallsignCounters): Promise<void> {
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(counters)}\n`);
  }
}
