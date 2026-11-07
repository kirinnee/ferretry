import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  GRANT_AUDIT_MAX_BYTES,
  type GrantAuditEntry,
  type GrantAuditView,
  type GrantHistoryPort,
} from '../../lib/grants/service.ts';

const lineBytes = (entry: GrantAuditEntry): number => new TextEncoder().encode(`${JSON.stringify(entry)}\n`).byteLength;

/**
 * Who changed a grant, when (today's grant journal, `state/grant-audit.jsonl`, through the kernel's state port). A
 * read covers at most {@link GRANT_AUDIT_MAX_BYTES} of the newest records and at most `limit` of them (G160); a file
 * the kernel could not read whole is counted unreadable rather than shown as empty.
 */
export class StateGrantHistory implements GrantHistoryPort {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, GrantAuditEntry>,
  ) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    await this.state.append(this.file, entry);
  }

  async recent(limit: number): Promise<GrantAuditView> {
    const all: GrantAuditEntry[] = [];
    try {
      for await (const entry of this.state.lines(this.file)) all.push(entry);
    } catch {
      return { entries: [], unreadable: 1, truncated: all.length > 0 };
    }
    const entries: GrantAuditEntry[] = [];
    let bytes = 0;
    for (const entry of all.toReversed()) {
      bytes += lineBytes(entry);
      if (entries.length >= limit || bytes > GRANT_AUDIT_MAX_BYTES) break;
      entries.push(entry);
    }
    return { entries, unreadable: 0, truncated: entries.length < all.length };
  }
}
