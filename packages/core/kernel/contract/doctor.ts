import { z } from 'zod';

/**
 * `GET /v1/doctor` (today's `protocol/src/lib/doctor.ts`, kept byte for byte): what the daemon could establish about
 * its host without running anything. The KERNEL serves it; every plugin's declared `doctor` checks are the rows.
 */

/** The kind of consequence a missing host program has. */
export const DoctorRequirementSchema = z.enum(['required', 'capability', 'optional', 'alternative']);
export type DoctorRequirement = z.infer<typeof DoctorRequirementSchema>;

/** What the daemon could establish about one host dependency without running it. */
export const DoctorCheckSchema = z.object({
  name: z.string().min(1),
  requirement: DoctorRequirementSchema,
  status: z.enum(['present', 'missing', 'not_applicable', 'unavailable_by_design']),
  summary: z.string().min(1),
  impact: z.string().min(1),
});
export type DoctorCheckReport = z.infer<typeof DoctorCheckSchema>;

/** The launchability evidence for a harness, repeated so one doctor snapshot is self-contained. */
export const DoctorHarnessSchema = z.object({
  kind: z.enum(['claude', 'codex']),
  launchable: z.array(z.string().min(1)),
  blocked: z.array(z.string().min(1)),
});
export type DoctorHarness = z.infer<typeof DoctorHarnessSchema>;

/** A daemon-scoped host-dependency diagnosis. Presence means PATH presence, unless stated otherwise. */
export const DoctorReportSchema = z.object({
  checks: z.array(DoctorCheckSchema),
  harnesses: z.array(DoctorHarnessSchema),
  ready: z.boolean(),
  limitation: z.string().min(1),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

/**
 * The sentence for a check a plugin declared and nobody has built yet. One owner for both ends: the daemon writes it
 * (`notBuiltSummary`) and a reader that wants to group those rows recognises it (`notBuiltCheck`) without the wire
 * growing a field.
 */
export const notBuiltSummary = (check: string): string =>
  `The check ${check} is not built yet in this build, so nothing was checked.`;

const NOT_BUILT = /^The check (.+) is not built yet in this build, so nothing was checked\.$/;

/** The check's name when `summary` is the not-built sentence, else `undefined`. */
export const notBuiltCheck = (summary: string): string | undefined => NOT_BUILT.exec(summary)?.[1];
