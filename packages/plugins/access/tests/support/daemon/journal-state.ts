import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { DevicesFile, GrantAuditFile, GrantAuditLineSchema } from '../../../contract/index.ts';
import { JournalGrantAudit, type TailStatePort } from '../../../daemon/adapters/grants/runtime-grant-ports.ts';

/** The approved kernel tail protocol, over memory only until its contract lands on 5.0. */
export function journalState(text = '') {
  const folder = new MemoryStateFolder();
  folder.plant(GrantAuditFile, text);
  const reads: number[] = [];
  const state: TailStatePort = {
    ...folder.port([GrantAuditFile, DevicesFile]),
    lines: () => {
      throw new Error('recent must never read the whole history');
    },
    version: async () => ({ size: new TextEncoder().encode(folder.raw(GrantAuditFile) ?? '').length, etag: 'fixture' }),
    tail: async (_file, { maxBytes }) => {
      reads.push(maxBytes);
      const all = new TextEncoder().encode(folder.raw(GrantAuditFile) ?? '');
      const from = Math.max(0, all.length - maxBytes);
      const bytes = all.subarray(from);
      const lines = new TextDecoder().decode(bytes).split('\n');
      if (from > 0 && all[from - 1] !== 10) lines.shift();
      const records = [];
      let unreadable = 0;
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed = GrantAuditLineSchema.safeParse(JSON.parse(line));
          if (parsed.success) records.push(parsed.data);
          else unreadable += 1;
        } catch {
          unreadable += 1;
        }
      }
      return { records, unreadable };
    },
  };
  return { folder, reads, state, audit: new JournalGrantAudit(state) };
}
