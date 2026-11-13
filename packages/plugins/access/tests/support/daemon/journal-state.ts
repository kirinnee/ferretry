import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { DevicesFile, GrantAuditFile } from '../../../contract/index.ts';
import { JournalGrantAudit } from '../../../daemon/adapters/grants/runtime-grant-ports.ts';

/** The kernel's own tail protocol over memory, with the window of every tail read recorded. */
export function journalState(text = '') {
  const folder = new MemoryStateFolder();
  folder.plant(GrantAuditFile, text);
  const reads: number[] = [];
  const base = folder.port([GrantAuditFile, DevicesFile]);
  const state: StatePort = {
    ...base,
    lines: () => {
      throw new Error('recent must never read the whole history');
    },
    tail: async (file, options) => {
      reads.push(options.maxBytes);
      return await base.tail(file, options);
    },
  };
  return { folder, reads, state, audit: new JournalGrantAudit(state) };
}
