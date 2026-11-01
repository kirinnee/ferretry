import { join } from 'node:path';
import {
  NotificationRecordSchema,
  type FileSystemPort,
  type FoundationPaths,
  type NotificationDeliveryLedger,
  type NotificationLedgerEntry,
  type NotificationLedgerHealth,
  type NotificationOutcomeRecord,
  type NotificationRecord,
} from '../../lib/index.ts';

/** What this ledger says about the lines it had to skip. */
export interface NotificationLedgerDiagnostics {
  warn(message: string): void;
}

/**
 * Durable notification decision state, as append-only JSONL.
 *
 * Every complete line should be one valid phase, every identity has at most one requested and one
 * outcome line, and an outcome only follows its request. A line that breaks this — malformed, of a shape
 * this daemon cannot read, or out of phase — is SKIPPED and counted, and every other line is still read.
 * The ledger used to fail closed on such a line, and one record an upgrade could not read (the agenda
 * rename's `attentionId`) silenced every push on every daemon that held one. Skipping costs at worst one
 * repeat push for the identity the skipped line named; refusing cost every push. The count is said in the
 * daemon log whenever it changes, and `fy doctor` reports it ({@link inspect}). An unterminated final
 * fragment is a crash artefact and is ignored without being counted.
 *
 * This file is decision state, not only evidence. Truncating or rotating it forgets delivered
 * identities and can cause one duplicate per retry then in flight. It has no admission cap; `find`
 * linearly scans a human-paced file, and bounded rotation remains a follow-up.
 */
export class FileNotificationDeliveryLedger implements NotificationDeliveryLedger {
  readonly path: string;
  /** The skipped-line count last said in the log, so a lookup says it only when it changes. */
  #toldSkipped = 0;

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'appendLineDurable'>,
    private readonly diagnostics?: NotificationLedgerDiagnostics,
  ) {
    this.path = join(paths.state, 'notifications.jsonl');
  }

  async append(record: NotificationRecord): Promise<void> {
    await this.files.appendLineDurable(this.path, JSON.stringify(NotificationRecordSchema.parse(record)));
  }

  async find(key: string): Promise<NotificationLedgerEntry | undefined> {
    return (await this.read()).entries.get(key);
  }

  /** How the ledger reads now: the lines it skips and the newest outcome. Total. */
  async inspect(): Promise<NotificationLedgerHealth> {
    try {
      const { skipped, latestOutcome } = await this.read();
      return { readable: true, skipped, ...(latestOutcome === undefined ? {} : { latestOutcome }) };
    } catch (error) {
      return { readable: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async read(): Promise<LedgerReading> {
    const reading = readLedger((await this.files.readText(this.path)) ?? '');
    if (reading.skipped !== this.#toldSkipped) {
      this.#toldSkipped = reading.skipped;
      this.warn(
        reading.skipped === 0
          ? `${this.path} reads cleanly again`
          : `${this.path}: ${reading.skipped} unreadable line${reading.skipped === 1 ? '' : 's'} skipped (first: line ${reading.firstSkippedLine}, ${reading.firstSkippedReason}); every other line is read`,
      );
    }
    return reading;
  }

  private warn(message: string): void {
    try {
      this.diagnostics?.warn(message);
    } catch {
      // Saying a line was skipped must never be what fails a lookup.
    }
  }
}

interface LedgerReading {
  readonly entries: ReadonlyMap<string, NotificationLedgerEntry>;
  readonly skipped: number;
  readonly firstSkippedLine?: number;
  readonly firstSkippedReason?: string;
  readonly latestOutcome?: NotificationOutcomeRecord;
}

function readLedger(text: string): LedgerReading {
  const entries = new Map<string, NotificationLedgerEntry>();
  let skipped = 0;
  let firstSkippedLine: number | undefined;
  let firstSkippedReason: string | undefined;
  let latestOutcome: NotificationOutcomeRecord | undefined;
  const skip = (line: number, reason: string) => {
    skipped += 1;
    if (firstSkippedLine === undefined) {
      firstSkippedLine = line;
      firstSkippedReason = reason;
    }
  };
  const complete = completeLines(text);
  if (complete === '') return { entries, skipped };
  for (const [index, line] of complete.slice(0, -1).split('\n').entries()) {
    const parsed = parseLine(line);
    if (!parsed.ok) {
      skip(index + 1, parsed.reason);
      continue;
    }
    const record = parsed.record;
    const entry = entries.get(record.key);
    if (record.phase === 'requested') {
      if (entry !== undefined) skip(index + 1, 'a second request for one notification');
      else entries.set(record.key, { requested: record });
    } else if (entry === undefined) {
      skip(index + 1, 'an outcome before its request');
    } else if (entry.outcome !== undefined) {
      skip(index + 1, 'a second outcome for one notification');
    } else {
      entries.set(record.key, { ...entry, outcome: record });
      latestOutcome = record;
    }
  }
  return {
    entries,
    skipped,
    ...(firstSkippedLine === undefined ? {} : { firstSkippedLine, firstSkippedReason }),
    ...(latestOutcome === undefined ? {} : { latestOutcome }),
  };
}

function completeLines(text: string): string {
  if (text.endsWith('\n')) return text;
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
}

function parseLine(
  line: string,
): { readonly ok: true; readonly record: NotificationRecord } | { readonly ok: false; readonly reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }
  const parsed = NotificationRecordSchema.safeParse(value);
  return parsed.success
    ? { ok: true, record: parsed.data }
    : { ok: false, reason: 'not a phase record this daemon reads' };
}
