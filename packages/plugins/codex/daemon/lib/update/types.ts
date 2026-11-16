/** The update wire types the contract states as schemas, named as types for the pure code beside them. */
import type { z } from 'zod';
import type {
  HarnessInstalledVersionSchema,
  HarnessUpdateJobSchema,
  HarnessUpdateOutcomeSchema,
  HarnessUpdatePlanSchema,
  HarnessUpdateReportSchema,
  UpdateCheckSchema,
} from '../../../contract/index.ts';

export type HarnessInstalledVersion = z.infer<typeof HarnessInstalledVersionSchema>;
export type HarnessUpdateJob = z.infer<typeof HarnessUpdateJobSchema>;
export type HarnessUpdateOutcome = z.infer<typeof HarnessUpdateOutcomeSchema>;
export type HarnessUpdatePlan = z.infer<typeof HarnessUpdatePlanSchema>;
export type HarnessUpdateReport = z.infer<typeof HarnessUpdateReportSchema>;
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;
