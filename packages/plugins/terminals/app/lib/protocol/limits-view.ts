import { z } from 'zod';

/**
 * WHAT THE FERRET LIMITS PANEL READS of `GET /v1/cgroups/config`: the daemon's own plain-words answer, nothing it would have to
 * compute. The daemon owns the whole view (`daemon/lib/protocol/limits.ts`; a half never imports its own daemon files, so the browser
 * never bundles its arithmetic); the panel parses only these fields, so a field the daemon adds later cannot make the page
 * refuse the answer, and a field it stops sending fails the parse here rather than drawing a guess.
 */
export const LimitsPanelViewSchema = z.object({
  switchedOn: z.boolean(),
  enforcement: z.enum(['cgroups', 'priority', 'none']),
  file: z.string().min(1),
  lines: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
});
export type LimitsPanelView = z.infer<typeof LimitsPanelViewSchema>;
