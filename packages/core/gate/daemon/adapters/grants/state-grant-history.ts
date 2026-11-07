import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  GRANT_AUDIT_MAX_BYTES,
  type GrantAuditEntry,
  GrantAuditEntrySchema,
  type GrantAuditView,
  type GrantHistoryPort,
} from '../../lib/grants/service.ts';

const lineBytes = (entry: unknown): number => new TextEncoder().encode(`${JSON.stringify(entry)}\n`).byteLength;

/**
 * One journal record, or nothing when it is not a grant change this daemon wrote (today's `readAuditLine`): each
 * entry is checked on its own, so one damaged record is COUNTED and the valid ones around it are still shown.
 */
export function readGrantAuditEntry(value: unknown): GrantAuditEntry | undefined {
  const parsed = GrantAuditEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Who changed a grant, when (today's `JournalGrantAudit`, `state/gate/grant-audit.jsonl`, through the kernel's state
 * port). A read covers at most {@link GRANT_AUDIT_MAX_BYTES} of the newest records and at most `limit` of them (G160).
 * A record that is not a grant change is counted unreadable, never skipped silently and never served; a file the
 * kernel could not read at all is counted unreadable rather than shown as empty.
 *
 * GAP (waiting on kernel `StatePort.tail`): the byte window is applied AFTER the kernel has read the whole file;
 * today reads only the last 64 KiB. GAP (waiting on kernel per-line `lines()`): a line that is not JSON at all still
 * makes the kernel refuse the whole file, which reads here as one unreadable record.
 */
export class StateGrantHistory implements GrantHistoryPort {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, unknown>,
  ) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    await this.state.append(this.file, entry);
  }

  async recent(limit: number): Promise<GrantAuditView> {
    const all: unknown[] = [];
    try {
      for await (const value of this.state.lines(this.file)) all.push(value);
    } catch {
      return { entries: [], unreadable: 1, truncated: all.length > 0 };
    }
    // The newest window of the file, as today's 64-KiB tail would see it.
    const window: unknown[] = [];
    let bytes = 0;
    for (const value of all.toReversed()) {
      bytes += lineBytes(value);
      if (bytes > GRANT_AUDIT_MAX_BYTES) break;
      window.push(value);
    }
    let unreadable = 0;
    const entries: GrantAuditEntry[] = [];
    for (const value of window) {
      const entry = readGrantAuditEntry(value);
      if (entry === undefined) unreadable += 1;
      else entries.push(entry);
    }
    return { entries: entries.slice(0, limit), unreadable, truncated: window.length < all.length };
  }
}
