import { join } from 'node:path';
import {
  NotificationRecordSchema,
  type FileSystemPort,
  type FoundationPaths,
  type NotificationDeliveryLedger,
  type NotificationLedgerEntry,
  type NotificationRecord,
} from '../../lib/index.ts';

/**
 * Durable notification decision state, as strict append-only JSONL.
 *
 * Every complete line must be one valid phase, every identity may have at most one requested and one
 * outcome line, and an outcome may only follow its request. Only an unterminated final fragment is a
 * crash artefact and may be ignored. Once a later append preserves that fragment as a complete line,
 * notification delivery fails closed until an operator removes the offending line; repairing it can
 * cause at worst one duplicate for an identity that was in flight at the crash.
 *
 * This file is decision state, not only evidence. Truncating or rotating it forgets delivered
 * identities and can cause one duplicate per retry then in flight. It has no admission cap; `find`
 * linearly scans a human-paced file, and bounded rotation remains a follow-up.
 */
export class FileNotificationDeliveryLedger implements NotificationDeliveryLedger {
  readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'appendLineDurable'>,
  ) {
    this.path = join(paths.state, 'notifications.jsonl');
  }

  async append(record: NotificationRecord): Promise<void> {
    await this.files.appendLineDurable(this.path, JSON.stringify(NotificationRecordSchema.parse(record)));
  }

  async find(key: string): Promise<NotificationLedgerEntry | undefined> {
    const text = await this.files.readText(this.path);
    if (text === undefined || text === '') return undefined;
    const complete = completeLines(text);
    if (complete === '') return undefined;

    const entries = new Map<string, NotificationLedgerEntry>();
    for (const line of complete.slice(0, -1).split('\n')) {
      const record = parseLine(line);
      const entry = entries.get(record.key);
      if (record.phase === 'requested') {
        if (entry !== undefined) throw new Error(`duplicate requested phase for ${record.key}`);
        entries.set(record.key, { requested: record });
      } else {
        if (entry === undefined) throw new Error(`outcome phase precedes requested for ${record.key}`);
        if (entry.outcome !== undefined) throw new Error(`duplicate outcome phase for ${record.key}`);
        entries.set(record.key, { ...entry, outcome: record });
      }
    }
    return entries.get(key);
  }
}

function completeLines(text: string): string {
  if (text.endsWith('\n')) return text;
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
}

function parseLine(line: string): NotificationRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('notification delivery ledger contains malformed JSON');
  }
  const parsed = NotificationRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error('notification delivery ledger contains an invalid phase record');
  return parsed.data;
}
