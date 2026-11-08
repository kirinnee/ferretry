import type { Log, Redaction, RedactionScope } from '@ferretry/kernel/contract';
import { type Duration, milliseconds } from '@ferretry/std';
import { RUNNER_LOOK_STATUS_BYTES, type FerretId, type Runner, type RunnerHandle } from '../../../../contract/index.ts';
import { type SessionId, tryParseSessionId } from '../../session-id.ts';
import type { LastSnapshotWriter } from './types.ts';

/**
 * The most characters a stored last screen keeps, counted from its end: the runner's own status window
 * ({@link RUNNER_LOOK_STATUS_BYTES}), so a frame is never longer on disk than the look that read it.
 */
export const LAST_SNAPSHOT_MAX_CHARS = RUNNER_LOOK_STATUS_BYTES;

/** How long a stop waits for its last-screen capture before it goes on without one. */
const LAST_SNAPSHOT_CAPTURE_BOUND = milliseconds(2_000);

/**
 * A captured frame masked as TEXT and then as ROWS, inside the one read scope it is given. `capture-pane` (no `-J`)
 * hands a line wider than the pane back as two rows, so a value printed near the right edge arrives split by a
 * `\n` that `text` cannot see across. `lines` matches the rows as one run (joined with nothing between them), so
 * each half of a wrapped value is starred in its own row. A run it matches across a REAL line break only adds `*`.
 */
function maskedFrame(scope: RedactionScope, frame: string): string {
  return scope.lines(scope.text(frame).split('\n')).join('\n');
}

/**
 * The text a capture keeps: the last {@link LAST_SNAPSHOT_MAX_CHARS} characters of an ALREADY MASKED frame. Cut after
 * the mask, never before it, so a cut can only shorten a run of `*`, never leave half a value unmasked. A cut that
 * lands inside a surrogate pair drops the orphaned half rather than writing a broken character.
 */
export function lastSnapshotText(masked: string): string {
  if (masked.length <= LAST_SNAPSHOT_MAX_CHARS) return masked;
  const tail = masked.slice(-LAST_SNAPSHOT_MAX_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** What a last-screen capture is built from. */
export interface LastSnapshotCaptureDeps {
  /** The writer for ONE ferret's own folder on the sessions root. */
  readonly store: (ferret: SessionId) => LastSnapshotWriter;
  /** The Vault's read-scoped masker, the same one the runner's look masks the frame with. */
  readonly redaction: Pick<Redaction, 'read'>;
  /** The kernel clock's sleep: the capture's bound is kernel time, so a driven clock drives it in a test. */
  readonly sleep: (delay: Duration, signal?: AbortSignal) => Promise<void>;
  readonly log: Pick<Log, 'warn'>;
  /** Default {@link LAST_SNAPSHOT_CAPTURE_BOUND}. */
  readonly bound?: Duration;
}

type CaptureOutcome = 'written' | 'nothing' | 'failed' | 'timed-out';

/**
 * The ferret's last screen, kept when it stops (today's `launcher.snapshot` before every stop, completion and pane
 * replacement, writing `last-snapshot.txt`): ONE look at the live pane through the runner's own `Runner.look` (which
 * reads inside `kernel.act(terminal %n, 'read')` and masks inside one `Redaction.read`), masked AGAIN here inside one
 * `Redaction.read`, as text and as rows ({@link maskedFrame}), before anything is written, cut to {@link LAST_SNAPSHOT_MAX_CHARS}, and written to the ferret's own
 * folder only.
 *
 * BEST EFFORT AND TOTAL. A stop never waits on it longer than its bound and never fails because of it: a pane already
 * gone, held or unreadable, a runner that cannot look, an empty screen, a masker that refuses, a write that fails and a
 * look that hangs all answer with no file and no error. A failure is logged by the ferret's id only: never the screen,
 * never the error's words (a filesystem error can quote a path, a masker's a value). A capture that outlives its bound
 * starts no write afterwards: the bound is checked just before the write begins. A write already begun when the bound
 * passes may still finish after the stop has moved on; it is the same frame of the same pane, renamed into place
 * whole, so the folder holds that frame or the one before it. (GAP: a write stalled for seconds by the filesystem
 * could in principle land after a LATER stop's frame of a resumed ferret and replace it with the older one.)
 */
export class LastSnapshotCapture {
  constructor(private readonly deps: LastSnapshotCaptureDeps) {}

  async capture(ferret: FerretId, runner: Runner, handle: RunnerHandle): Promise<void> {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return;
    const abandon = new AbortController();
    try {
      const outcome = await Promise.race<CaptureOutcome>([
        this.captureOnce(id, runner, handle, abandon.signal).catch(() => 'failed' as const),
        this.deps.sleep(this.deps.bound ?? LAST_SNAPSHOT_CAPTURE_BOUND, abandon.signal).then(
          () => 'timed-out' as const,
          () => 'failed' as const,
        ),
      ]);
      if (outcome === 'failed') this.deps.log.warn("a ferret's last screen could not be kept", { ferret: id });
      if (outcome === 'timed-out')
        this.deps.log.warn("a ferret's last screen was not kept: reading it took too long", { ferret: id });
    } catch {
      // Total: a logger that throws is not a stop that fails.
    } finally {
      abandon.abort();
    }
  }

  private async captureOnce(
    id: SessionId,
    runner: Runner,
    handle: RunnerHandle,
    abandoned: AbortSignal,
  ): Promise<CaptureOutcome> {
    const look = await runner.look?.(handle);
    const screen = look?.status;
    // Today's rule: only a frame actually observed on a live pane is kept; a blank one is not evidence of anything.
    if (screen === undefined || screen.trim() === '') return 'nothing';
    const masked = await this.deps.redaction.read(scope => maskedFrame(scope, screen));
    if (typeof masked !== 'string' || masked.trim() === '') return 'nothing';
    // The bound is checked here, before the write starts; a write already begun is not called back (see the class).
    if (abandoned.aborted) return 'nothing';
    await this.deps.store(id).write(id, lastSnapshotText(masked));
    return 'written';
  }
}
