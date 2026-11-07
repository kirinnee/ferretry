import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClockPort } from '../../../lib/ports.ts';
import { DEFAULT_COMPLETION_SUMMARY } from '../../../lib/session/signal/policy.ts';
import type { SignalArtifacts } from '../../../lib/session/signal/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * The evidence a signal leaves inside the session's own private directory.
 *
 * THE MARKER FILENAMES ARE A CONTRACT WITH THE REVIVE, not a local choice. `FileResumeTurnStore`
 * already removes `done.marker` and `needs-help.marker` before every relaunch, so a completion
 * written under any other name would survive a revive and end the new turn the moment it started.
 * That store shipped clearing markers nothing wrote; this is the writer it was waiting for.
 *
 * THE DONE MARKER CARRIES THE TURN IT CERTIFIES, which kteam learned to do the expensive way. A later
 * turn bumps the persisted turn before it is delivered, so a daemon death in that window would let a
 * marker from an older turn certify work that never ran. A reader must compare the turn, and it can
 * only do that if the writer recorded one.
 */
export class FileSignalArtifacts implements SignalArtifacts {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly clock: ClockPort,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async writeSummary(id: SessionId, message: string | undefined): Promise<void> {
    const trimmed = message?.trim();
    const document = trimmed === undefined || trimmed === '' ? DEFAULT_COMPLETION_SUMMARY : `${trimmed}\n`;
    await this.write(join(this.sessionDirectory(id), 'summary.md'), document);
  }

  async markDone(id: SessionId, turn: number): Promise<void> {
    await this.write(
      join(this.sessionDirectory(id), 'done.marker'),
      `${JSON.stringify({ at: this.clock.now(), type: 'done', turn })}\n`,
    );
  }

  /**
   * The question, in two places that answer different questions.
   *
   * The OUTBOX is the conversation: an append-only log a lead reads in order, so a session that asked
   * twice shows both. The MARKER is the current condition: one file a supervisor stats without parsing
   * a log, and the one the revive clears. Writing only the log would leave nothing for the revive to
   * clear; writing only the marker would lose the first question when a second arrived.
   */
  async raiseQuestion(id: SessionId, message: string): Promise<void> {
    const directory = this.sessionDirectory(id);
    const at = this.clock.now();
    const outbox = join(directory, 'channel', 'outbox.jsonl');
    await mkdir(dirname(outbox), { recursive: true, mode: 0o700 });
    await appendFile(outbox, `${JSON.stringify({ at, type: 'question', message })}\n`, { mode: 0o600 });
    await this.write(join(directory, 'needs-help.marker'), `${JSON.stringify({ at, type: 'question', message })}\n`);
  }

  /** Written through a temporary file and renamed, so no reader ever sees a half-written marker. */
  private async write(file: string, document: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }
}
