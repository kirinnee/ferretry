/**
 * The daemon's update view, copied from today's `protocol/src/lib/daemon-update.ts`: the last check, the update in
 * flight or the report the last one left, and what the app and `fy update` read of them.
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { InstallMethodSchema, UpdatePlanSchema } from './install.ts';
import { type LatestRelease, LatestReleaseSchema } from './release.ts';
import { VersionSchema } from './version.ts';

export const UpdateCheckSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('never') }),
  z.strictObject({ state: z.literal('ok'), checkedAt: InstantSchema, latest: LatestReleaseSchema }),
  z.strictObject({
    state: z.literal('failed'),
    checkedAt: InstantSchema,
    reason: z.string().min(1),
    /** The last answer that worked, kept so a failed check does not hide a known update. */
    lastKnown: z.strictObject({ checkedAt: InstantSchema, latest: LatestReleaseSchema }).optional(),
  }),
]);
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;

/** The latest release this check knows of, from a fresh answer or the last good one. */
export function knownLatestRelease(check: UpdateCheck): LatestRelease | undefined {
  if (check.state === 'ok') return check.latest;
  if (check.state === 'failed') return check.lastKnown?.latest;
  return undefined;
}

export const UpdateOutcomeSchema = z.enum(['succeeded', 'rolled-back', 'failed']);
export type UpdateOutcome = z.infer<typeof UpdateOutcomeSchema>;

/**
 * What `fy update --report <file>` writes when it finishes, for the NEW daemon to read.
 *
 * It is the one thing that crosses the restart: the process that started the update is gone by the
 * time it ends, so the outcome has to wait on disk for whichever daemon comes up.
 */
export const UpdateReportSchema = z.strictObject({
  from: VersionSchema,
  target: VersionSchema,
  outcome: UpdateOutcomeSchema,
  /** One plain sentence: what happened, and what to do if anything. */
  message: z.string().min(1),
  finishedAt: InstantSchema,
});
export type UpdateReport = z.infer<typeof UpdateReportSchema>;

export const UpdateJobSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('waiting-for-idle'),
    target: VersionSchema,
    requestedAt: InstantSchema,
    midTurn: NonNegativeIntegerSchema,
  }),
  z.strictObject({ state: z.literal('running'), target: VersionSchema, startedAt: InstantSchema }),
  z.strictObject({ state: z.literal('finished'), report: UpdateReportSchema }),
]);
export type UpdateJob = z.infer<typeof UpdateJobSchema>;

export const DaemonUpdateViewSchema = z.strictObject({
  current: VersionSchema,
  method: InstallMethodSchema,
  plan: UpdatePlanSchema,
  check: UpdateCheckSchema,
  /** A newer release is known — `isUpdateAvailable(current, knownLatestRelease(check))`. */
  available: z.boolean(),
  /**
   * Ferrets mid-turn right now. Informational: an update started `now` goes ahead anyway, because
   * ferrets keep running through a restart; `when-idle` and an automatic install wait for zero.
   */
  midTurn: NonNegativeIntegerSchema,
  /** "Install updates automatically when idle" — off unless somebody turned it on. */
  autoInstall: z.boolean(),
  /** The update in flight, or the last one that finished; `null` when there has been none. */
  job: UpdateJobSchema.nullable(),
});
export type DaemonUpdateView = z.infer<typeof DaemonUpdateViewSchema>;
