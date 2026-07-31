import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MigrationReportStore } from '../../lib/migrate/report-store.ts';
import type { SessionId } from '../../lib/session-id.ts';

/** The one report per session, beside the turn documents a revive writes into the same directory. */
const REPORT_FILE = 'migration-inflight.md';

/**
 * The migration report inside the session's own private directory.
 *
 * The first half is written ATOMICALLY through a temporary file, for the same reason the turn store
 * is: the agent that reads this document is handed its path by the very relaunch that follows the
 * write, so a torn document is one a migrated agent reads as its account of what was interrupted.
 *
 * The outcome half is APPENDED rather than rewritten, because by then the inventory it follows is
 * the only surviving evidence of what the kill destroyed — a rewrite that failed part-way would take
 * that with it. An append also keeps the file honest about ordering: the pending inventory was true
 * when it was written, and the outcome is a later fact about it.
 *
 * ONE report per session, deliberately overwritten by a second migration. A session that is moved
 * twice was moved twice for a reason, and the journal carries both `session.migrating` events with
 * their targets; keeping a numbered pile of reports in the session directory would grow without
 * bound while the handoff message could only ever name one of them.
 */
export class FileMigrationReportStore implements MigrationReportStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  /** Where this session's report lives. Public so a caller can name it before deciding to write. */
  file(id: SessionId): string {
    return join(this.sessionDirectory(id), REPORT_FILE);
  }

  async write(id: SessionId, document: string): Promise<string> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    return file;
  }

  async append(id: SessionId, section: string): Promise<void> {
    await appendFile(this.file(id), section, { encoding: 'utf8', mode: 0o600 });
  }
}
