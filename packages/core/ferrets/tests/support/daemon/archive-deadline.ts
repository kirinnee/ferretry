import { RecordingLog } from './storage.ts';

/** The deadline, timer and log the archive adapter asks for, for a fixture whose keeps never hang: a timer that never fires. */
export const archiveDeadline = () => ({
  after:
    (_delayMs: number, _fire: () => void): (() => void) =>
    () =>
      undefined,
  keepsDeadlineMs: 10_000,
  log: new RecordingLog(),
});
