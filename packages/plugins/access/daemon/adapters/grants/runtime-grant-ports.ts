import type { StatePort } from '@ferretry/kernel/contract';
import { GrantAuditFile, type GrantAuditLine } from '../../../contract/index.ts';
import type { GrantAuditEntry, GrantAuditPort, GrantAuditReading } from '../../lib/grants/index.ts';

/** TODO(kernel contract): additive StatePort.tail, approved by the lead; never fall back to a full scan. */
export interface TailStatePort extends StatePort {
  version(file: typeof GrantAuditFile): Promise<{ readonly size: number; readonly etag: string } | undefined>;
  tail(
    file: typeof GrantAuditFile,
    options: { readonly maxBytes: number },
  ): Promise<{ readonly records: readonly GrantAuditLine[]; readonly unreadable: number }>;
}

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
    const state = this.state as Partial<TailStatePort>;
    if (state.tail === undefined || state.version === undefined)
      throw new Error('the kernel does not provide bounded journal tail reads yet');
    const information = await state.version(GrantAuditFile);
    const { records, unreadable: damaged } = await state.tail(GrantAuditFile, { maxBytes: AUDIT_WINDOW_BYTES });
    let unreadable = damaged;
    for (const line of records) {
      if (line.kind !== this.kind) unreadable += 1;
      else entries.push({ at: line.at, actor: line.actor, changes: line.changes });
    }
    const truncated = information !== undefined && information.size > AUDIT_WINDOW_BYTES;
    return { entries: entries.reverse().slice(0, limit), unreadable, truncated };
  }
}
