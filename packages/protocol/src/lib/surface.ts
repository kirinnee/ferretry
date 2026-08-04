/**
 * WHO OPENED A SURFACE — the wire half of durable, visible ownership.
 *
 * A "surface" is an addressable thing a session holds and a reader can be handed
 * a reference to: a terminal today, a browser page when a worker exists. This
 * module owns only the opener, because the opener is the one fact that must mean
 * the same thing for every surface kind — a reader consults it before typing into
 * a shell an agent may be driving, and "which agent" cannot be a per-kind
 * invention.
 *
 * THE OPENER IS SERVER-DERIVED, NEVER SELF-REPORTED BY A REMOTE DEVICE. The
 * daemon knows which credential class authenticated a request: a paired device is
 * a human holding a phone or a laptop, and the box's own admin token is something
 * running locally. A remote device therefore cannot open a terminal and label it
 * as an agent's, which is what keeps `by: 'agent'` worth reading at all. The only
 * thing a caller may declare is WHICH agent it is acting for, and only from a
 * local admin credential — see `CreateTerminalRequestSchema.agentSessionId`.
 *
 * ABSENCE IS A FOURTH ANSWER AND IT IS DELIBERATE. `openedBy` is optional on
 * every view that carries it. A terminal opened before this daemon recorded
 * provenance, or by a build that never did, has no opener — and a reader is told
 * "unrecorded" rather than being shown a guess. A guess that is usually right is
 * still a claim made without evidence, and this is exactly the fact that decides
 * whether someone types into a shell.
 */

import { z } from 'zod';

/** An opaque identity minted by the daemon, long enough for a uuid. */
const OpaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);

export const SurfaceOpenerSchema = z.discriminatedUnion('by', [
  /** A paired device presented its own credential: a human, at that device. */
  z.strictObject({ by: z.literal('human'), deviceId: OpaqueIdSchema }),
  /** The local admin credential, acting for a named agent session. */
  z.strictObject({ by: z.literal('agent'), sessionId: OpaqueIdSchema }),
  /**
   * The local admin credential with no agent declared — something on the box
   * opened this, and the daemon cannot say which. Reported as itself rather than
   * folded into `human`: "the box did it" and "the person did it" are different
   * facts, and only one of them means nobody else is typing.
   */
  z.strictObject({ by: z.literal('local') }),
]);
export type SurfaceOpener = z.infer<typeof SurfaceOpenerSchema>;
