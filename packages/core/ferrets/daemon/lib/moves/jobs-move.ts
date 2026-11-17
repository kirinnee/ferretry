import type { JobKeeperSource } from '../../../contract/job-keeping.ts';
import { bounded, KEEPER_TIMEOUT_MS } from './bounded.ts';
import { detachAttachments } from './detach-attachments.ts';
import type { InflightReport } from './inflight-report.ts';
import { jobsHandover, toldAbout, withJobsSection } from './jobs-handover.ts';

/** What the jobs part of a pane-killing move needs: the keeper (if one is contributed), a clock and a log. */
export interface JobsMovePorts {
  /** Terminals' job keeper, read at the moment of the move; absent, nothing is known, detached or handed over. */
  readonly keeper: () => JobKeeperSource | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  /** How long each keeper question may take (default {@link KEEPER_TIMEOUT_MS}); a test shortens it. */
  readonly keeperTimeoutMs?: number;
  readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
}

/** What a move hands the new session about the jobs, and what to record once the new session really started. */
export interface JobsHandOff {
  /** The "Your jobs" section, or `undefined` when there is nothing to say. */
  readonly section: string | undefined;
  /** The finished jobs the section told the ferret about: record them with {@link markJobsTold} AFTER the relaunch. */
  readonly told: readonly string[];
}

/**
 * THE JOBS HALF OF EVERY PANE-KILLING MOVE — a Restart and a move onto another login both run `relaunchInPlace`, which calls this, so neither can skip it.
 *
 * Run it after the gate passed and immediately BEFORE the old pane is killed. The jobs are kept, so the attachments let
 * go first: each `fy job attach` prints its detach message and exits 75 while the old harness is alive to read it, instead
 * of being killed with the pane (which Claude would read as a stopped task). The jobs themselves are untouched. A keeper
 * that fails or hangs must not stop the move — the kill breaks the attachments anyway — so every failure is logged and
 * answered with "nothing to say".
 */
export async function handOffJobs(ports: JobsMovePorts, ferret: string, report: InflightReport): Promise<JobsHandOff> {
  const keeper = ports.keeper();
  if (keeper === undefined) return { section: undefined, told: [] };
  await detachAttachments(keeper, ferret, {
    sleep: ports.sleep,
    nowMs: ports.nowMs,
    log: ports.log,
    ...(ports.keeperTimeoutMs === undefined ? {} : { timeoutMs: ports.keeperTimeoutMs }),
  });
  try {
    const kept = await bounded(
      keeper.jobs(ferret),
      ports.keeperTimeoutMs ?? KEEPER_TIMEOUT_MS,
      'the job keeper',
      ports.sleep,
    );
    return { section: jobsHandover(kept, report, ports.nowMs()), told: toldAbout(kept) };
  } catch (error) {
    ports.log.warn("the hand-over could not list the ferret's jobs", { ferret, error: String(error) });
    return { section: undefined, told: [] };
  }
}

/** Records that the new session was told how these jobs ended. Call it only after the relaunch reported `revived`. */
export async function markJobsTold(ports: JobsMovePorts, ferret: string, told: readonly string[]): Promise<void> {
  const keeper = ports.keeper();
  if (keeper === undefined || told.length === 0) return;
  await bounded(
    keeper.markReported(ferret, told),
    ports.keeperTimeoutMs ?? KEEPER_TIMEOUT_MS,
    'the job keeper',
    ports.sleep,
  ).catch((error: unknown) => {
    ports.log.warn('finished jobs could not be marked as told', { ferret, error: String(error) });
  });
}

/** The new session's first message: the owner's note, then the restart notice, then the jobs section — whichever exist. */
export function handoverMessage(
  note: string | undefined,
  notice: string | undefined,
  section: string | undefined,
): string | undefined {
  const body = withJobsSection(notice, section);
  if (note === undefined) return body;
  return body === undefined ? note : `${note}\n\n${body}`;
}
