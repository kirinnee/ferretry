import type { ClockPort, FileSystemPort } from '../../../lib/ports.ts';
import type { SessionHealthEventSink } from '../../../lib/session/health/service.ts';
import type { SessionHealthEvent } from '../../../lib/session/health/types.ts';

/**
 * Fleet-wide health events, appended durably to a daemon-owned journal.
 *
 * They are recorded rather than only logged because the failures they describe — a starved event
 * loop, an index that will not heal — are invisible by the time an operator looks, and a log line
 * that has already rotated proves nothing about last week's wedge. They go to a daemon journal
 * rather than a session's, because none of them belong to a session.
 */
export class FileSessionHealthEventSink implements SessionHealthEventSink {
  constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly file: string,
    private readonly clock: ClockPort,
  ) {}

  async emit(event: SessionHealthEvent): Promise<void> {
    await this.fileSystem.appendLineDurable(
      this.file,
      JSON.stringify({ at: this.clock.now(), type: event.type, data: event.data }),
    );
  }
}
