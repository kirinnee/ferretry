import type { StatePort } from '@ferretry/kernel/contract';
import { GrantAuditFile, type GrantAuditLine } from '../../../contract/index.ts';
import type { GrantAuditEntry, GrantAuditPort, GrantAuditReading } from '../../lib/grants/index.ts';

/**
 * The grant journal (`grant-audit.jsonl`, G150, P122): one line per device-grant or security change, attributed to
 * its actor and never carrying a credential. Today's `JournalGrantAudit`, on the kernel's append-only JSONL store.
 *
 * `kind` keeps the two histories apart in one file: the grant journal writes `grant.changed`, the security journal
 * `security.changed`, and a reader of one never mistakes the other's lines for its own.
 */
export class JournalGrantAudit implements GrantAuditPort {
  constructor(
    private readonly state: StatePort,
    private readonly kind: string = 'grant.changed',
  ) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    const line: GrantAuditLine = {
      format: 1,
      kind: entry.kind ?? this.kind,
      at: entry.at as GrantAuditLine['at'],
      actor: entry.actor,
      changes: [...entry.changes],
    };
    await this.state.append(GrantAuditFile, line);
  }

  /**
   * The newest `limit` records of this journal's kind, newest first. The kernel parses each line against the file's
   * schema; a line it cannot read is its damage to report, not a record here.
   */
  async recent(limit: number): Promise<GrantAuditReading> {
    const entries: GrantAuditEntry[] = [];
    for await (const line of this.state.lines(GrantAuditFile)) {
      if (line.kind !== this.kind) continue;
      entries.push({ at: line.at, actor: line.actor, changes: line.changes });
    }
    return { entries: entries.reverse().slice(0, limit), unreadable: 0, truncated: false };
  }
}
