import { z } from 'zod';

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
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

/** The existing launchability evidence, repeated so one doctor snapshot is self-contained. */
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
