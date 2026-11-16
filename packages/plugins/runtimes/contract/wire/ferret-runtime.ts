/** Running-ferret controls, copied from today's protocol session.ts. */
import { z } from 'zod';
export const RuntimeControlRequestSchema = z.discriminatedUnion('action', [
  // Codex's native picker can be opened without selecting a target. It is a
  // real control operation, but deliberately makes no claim about the eventual
  // model; targeted callers supply both opaque values unchanged.
  z.strictObject({
    action: z.literal('model'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal('effort'), effort: z.string().min(1) }),
  // Fast mode is a switch, not a level: `true` turns it on and `false` off, and either is applied
  // with the harness's own command at an idle prompt and confirmed by what the harness then reports.
  z.strictObject({ action: z.literal('fast'), fast: z.boolean() }),
  z.strictObject({ action: z.literal('compact') }),
]);
export type RuntimeControlRequest = z.infer<typeof RuntimeControlRequestSchema>;
