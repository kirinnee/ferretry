import type { CapabilityGrants, DaemonCapability } from '@ferretry/protocol';
import type {
  FileSystemPort,
  GrantAuditEntry,
  GrantAuditPort,
  GrantAuditReading,
  GrantClock,
  GrantDocumentPort,
  SerialExecutor,
  SharingRepairJournal,
  WholeJournal,
} from '../../lib/index.ts';

/** The daemon configuration document, seen as the one thing the grant subsystem needs from it. */
export interface GrantConfigStore {
  readGrants(): Promise<CapabilityGrants>;
  writtenGrants(): Promise<readonly DaemonCapability[]>;
  writeGrants(grants: CapabilityGrants): Promise<void>;
}

/**
 * The grants, in the operator's own configuration document.
 *
 * A THIN ADAPTER over the configuration store rather than a second file, because grants are exactly
 * the kind of thing `--print-config` exists to report with provenance: an operator asking what this
 * daemon believes it may do should read the answer beside `port` and `corsOrigins`, not hunt for a
 * separate document.
 */
export class ConfigGrantDocument implements GrantDocumentPort {
  constructor(
    private readonly config: GrantConfigStore,
    private readonly mutations: Pick<SerialExecutor, 'runExclusive'>,
  ) {}

  async read(): Promise<CapabilityGrants> {
    return await this.config.readGrants();
  }

  async written(): Promise<readonly DaemonCapability[]> {
    return await this.config.writtenGrants();
  }

  async write(grants: CapabilityGrants): Promise<void> {
    // Pricing patch/apply holds this SAME barrier across its read, decision, and raw-document write.
    // Joining it here makes the grant adapter's own read-modify-write one transaction relative to
    // pricing, so two atomic renames cannot each preserve the same stale copy and erase the other's
    // key. The grant service's authorization and audit semantics remain outside this file adapter.
    await this.mutations.runExclusive(() => this.config.writeGrants(grants));
  }
}

export class SystemGrantClock implements GrantClock {
  nowMs(): number {
    return Date.now();
  }
}

/**
 * A grant change, appended to this daemon's own durable grant journal.
 *
 * WHY IT IS NOT OPTIONAL. A permission model whose changes leave no trace can only ever be understood
 * by its effects, so "when did this machine start letting a phone apply the fleet, and who said so"
 * becomes unanswerable at exactly the moment somebody needs it answered — which is the same reason
 * board permissions were made auditable rather than implicit.
 *
 * IT RECORDS THE ACTOR, NEVER A CREDENTIAL. `device:<id>` and `admin-ui` say who; a token would say
 * how, and putting that in an append-only file is how a durable record becomes a durable secret.
 *
 * IT LIVES IN THE STATE HOME, so it is keyed by daemon by construction: one daemon's record can never
 * be read as another's, because a state home has exactly one owner.
 */
export class JournalGrantAudit implements GrantAuditPort, SharingRepairJournal {
  constructor(
    private readonly path: string,
    private readonly files: FileSystemPort,
    /**
     * The record kind this journal writes and reads back. The grant journal is `grant.changed`; the
     * security settings journal is `security.changed` (`docs/design/zero-trust.md` B6). One kind per
     * file, so a reader never mistakes one history for the other.
     */
    private readonly kind: string = 'grant.changed',
  ) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    await this.files.appendLineDurable(
      this.path,
      JSON.stringify({ kind: entry.kind ?? this.kind, at: entry.at, actor: entry.actor, changes: entry.changes }),
    );
  }

  /**
   * The most recent records, newest first.
   *
   * IT READS THE TAIL, NOT THE FILE. This journal is append-only and never rotated, so a machine
   * reconfigured over a year would otherwise have its whole history materialised to answer "what
   * changed recently". A window of {@link AUDIT_WINDOW_BYTES} is read from the end, and the first
   * line in it is dropped when the window started mid-record — a half-record parsed as a whole one
   * is a fabricated history entry, which is worse than a missing one.
   *
   * A LINE IT CANNOT PARSE IS COUNTED, NOT SKIPPED. Dropping damage silently would let a truncated or
   * tampered journal read as a clean history, which is the absent-evidence-as-benign-result defect
   * this product has been bitten by repeatedly. The caller is told the count and can say so.
   */
  async recent(limit: number): Promise<GrantAuditReading> {
    const information = await this.files.information(this.path);
    if (information === undefined) return { entries: [], unreadable: 0, truncated: false };
    const size = information.size;
    const from = Math.max(0, size - AUDIT_WINDOW_BYTES);
    const bytes = await this.files.readSlice(this.path, from, size - from);
    if (bytes === undefined) return { entries: [], unreadable: 0, truncated: from > 0 };
    const lines = new TextDecoder().decode(bytes).split('\n');
    // The window may have opened mid-record; that first fragment is not a record and must not be
    // reported as an unreadable one either, because nothing is actually wrong with the file.
    if (from > 0) lines.shift();
    let unreadable = 0;
    const entries: GrantAuditEntry[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      const parsed = readAuditLine(line, this.kind);
      if (parsed === undefined) unreadable += 1;
      else entries.push(parsed);
    }
    return { entries: entries.reverse().slice(0, limit), unreadable, truncated: from > 0 };
  }

  /**
   * Every record in the journal, or `too-large` past `maxBytes` — for a decision that must not miss an old
   * record (the Sharing repair, `sharing-follows-pairing.ts`). Unreadable lines are counted, as `recent` does.
   */
  async readAll(maxBytes: number): Promise<WholeJournal> {
    const information = await this.files.information(this.path);
    if (information === undefined) return { kind: 'read', entries: [], unreadable: 0 };
    if (information.size > maxBytes) return { kind: 'too-large' };
    const bytes = await this.files.readSlice(this.path, 0, information.size);
    // A file that exists but would not read back is NOT an empty history: whatever it holds is unknown.
    if (bytes === undefined) return { kind: 'read', entries: [], unreadable: 1 };
    let unreadable = 0;
    const entries: GrantAuditEntry[] = [];
    for (const line of new TextDecoder().decode(bytes).split('\n')) {
      if (line.trim() === '') continue;
      const parsed = readAuditLine(line, this.kind);
      if (parsed === undefined) unreadable += 1;
      else entries.push(parsed);
    }
    return { kind: 'read', entries, unreadable };
  }
}

/**
 * How much of the journal's tail one read covers.
 *
 * 64 KiB is thousands of records — far more than the bounded page ever returns — so the window is
 * about capping the ALLOCATION rather than the answer. A cap applied after the file is in memory is
 * a cap applied too late.
 */
const AUDIT_WINDOW_BYTES = 64 * 1024;

/** One journal line, or nothing when it is not a record this daemon wrote. */
function readAuditLine(line: string, kind: string): GrantAuditEntry | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.kind !== kind) return undefined;
    const { at, actor, changes } = value;
    if (typeof at !== 'string' || typeof actor !== 'string' || !Array.isArray(changes)) return undefined;
    if (at === '' || actor === '' || !changes.every(change => typeof change === 'string')) return undefined;
    return { at, actor, changes: changes as readonly string[] };
  } catch {
    return undefined;
  }
}
