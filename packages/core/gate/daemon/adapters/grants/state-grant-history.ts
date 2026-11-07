import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { GrantAuditEntryView, GrantAuditView } from '../../../contract/index.ts';
import { GRANT_AUDIT_MAX_BYTES, type GrantHistoryPort } from '../../lib/grants/service.ts';

/**
 * Who changed a grant, when (today's `JournalGrantAudit`, `state/gate/grant-audit.jsonl`, through the kernel's state
 * port).
 *
 * IT READS THE TAIL, NOT THE FILE (G160). The journal is append-only and never rotated, so a read covers only the last
 * {@link GRANT_AUDIT_MAX_BYTES} — the kernel's `tail` reads no more than that from disk, and drops the line the window
 * opened in the middle of rather than counting it — and returns at most `limit` entries, newest first.
 *
 * A LINE IT CANNOT READ IS COUNTED, NOT SKIPPED SILENTLY: each line is checked on its own against the file's schema, so
 * one damaged record is counted unreadable and the valid ones around it are still shown.
 */
export class StateGrantHistory implements GrantHistoryPort {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, GrantAuditEntryView>,
    private readonly maxBytes: number = GRANT_AUDIT_MAX_BYTES,
  ) {}

  async record(entry: GrantAuditEntryView): Promise<void> {
    await this.state.append(this.file, entry);
  }

  async recent(limit: number): Promise<GrantAuditView> {
    const size = (await this.state.version(this.file))?.size ?? 0;
    if (size === 0) return { entries: [], unreadable: 0, truncated: false };
    const read = await this.state.tail(this.file, { maxBytes: this.maxBytes });
    return {
      entries: read.records.toReversed().slice(0, limit),
      unreadable: read.unreadable,
      truncated: size > this.maxBytes,
    };
  }
}
