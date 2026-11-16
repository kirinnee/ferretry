/**
 * The CLI's copy of what `GET /v1/ferrets/:ferretId/attach` answers (the daemon's `SessionAttachTargetSchema` in
 * `lib/protocol/session-processes.ts`): short-lived proof of which pane a ferret runs in. It belongs in the contract.
 */
import { PositiveIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

export const AttachTargetSchema = z.strictObject({
  /** The private tmux server owned by the daemon that answered the request. */
  socketPath: z.string().min(1).regex(/^\//u, 'the tmux socket path must be absolute'),
  tmuxSession: z.string().min(1),
  paneId: z.string().regex(/^%(?:0|[1-9][0-9]*)$/u),
  pid: PositiveIntegerSchema.refine(value => value > 1, 'the pane pid must be greater than one'),
  /** The pane process's start identity (Linux start ticks, macOS epoch seconds), which tells a reused pid apart. */
  processStartTicks: PositiveIntegerSchema,
});
export type AttachTarget = z.infer<typeof AttachTargetSchema>;
