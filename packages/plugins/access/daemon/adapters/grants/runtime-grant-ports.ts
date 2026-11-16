import type { StatePort } from '@ferretry/kernel/contract';
import { GrantAuditFile, type GrantAuditLine } from '../../../contract/index.ts';
import type { GrantAuditEntry, GrantAuditPort, GrantAuditReading } from '../../lib/grants/index.ts';

const AUDIT_WINDOW_BYTES = 64 * 1024;

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
   * Today's bounded tail: drop the first partial record, count damage, return the newest surviving records.
   */
  async recent(limit: number): Promise<GrantAuditReading> {
    const entries: GrantAuditEntry[] = [];
    const information = await this.state.version(GrantAuditFile);
    const { records, unreadable: damaged } = await this.state.tail(GrantAuditFile, { maxBytes: AUDIT_WINDOW_BYTES });
    for (const line of records) {
      // The kernel already validated each record: another journal's kind is healthy, not damaged bytes.
      if (line.kind === this.kind) entries.push({ at: line.at, actor: line.actor, changes: line.changes });
    }
    const truncated = information !== undefined && information.size > AUDIT_WINDOW_BYTES;
    return { entries: entries.reverse().slice(0, limit), unreadable: damaged, truncated };
  }
}
