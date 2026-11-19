/**
 * Access's wire (§2.1) beyond today's protocol files: what other plugins hand Access, and Access's own state file.
 * The route bodies are copied from today's `packages/protocol/src/lib/{pairing,push,step-up,grants}.ts` into
 * `pairing.ts`, `push.ts`, `step-up.ts` and `grants.ts` beside this file.
 *
 * THERE IS NO DEVICE TOKEN, AND NO SCHEMA FOR ONE. A paired device proves itself by signing each session's
 * transcript with a key it cannot export; the daemon holds only the public half, and no view here carries it.
 */
import { PushEnvelopeFields } from '@ferretry/kernel/contract/push-envelope';
import { z } from 'zod';

/**
 * One buzz as another plugin hands it to Access (Agenda's `uses`): words only, never a secret. Its `title`, `body` and
 * `url` ARE the push envelope, with the envelope's caps (declared once in the kernel contract), so a buzz the shell worker
 * could not read is refused where it is sent. Its `tag` is NOT refused for the kernel's tag grammar: a buzz whose tag
 * would not fit is sent untagged (`fittingPushTag`), so it still reaches the phone.
 */
export const BuzzSchema = z.strictObject({
  tag: z.string().min(1).max(200),
  ...PushEnvelopeFields,
  /** A push about a one-time code or a sign-in the owner approves on their phone is reached at once (`high`); absent is every other. */
  urgency: z.literal('high').optional(),
  /**
   * Names the ONE event this buzz is about (a repeat of it, such as a push service's re-delivery, carries the same key). Never
   * the `tag`, which names the line it replaces and so is shared by distinct events; never words or a secret. Absent: the
   * buzz is never skipped as a twin.
   */
  eventKey: z.string().min(1).max(400).optional(),
  /** How long a push service may hold it undelivered, when it is about something that ends sooner (an approval's seconds left; the daemon clamps it to a high push's own limit). */
  ttlSeconds: z.number().int().min(0).max(3_600).optional(),
  /**
   * The ferret (session id) the buzz is about. Only the hourly cap on high-priority pushes reads it: three an hour per
   * ferret, twelve across the daemon. A high buzz that names none counts against the daemon's twelve only.
   */
  ferret: z.string().min(1).max(200).optional(),
  /** What the push is about, for the device's own filter (a no-session kind: `pr`, `ci`). Absent: never hidden by kind. */
  kind: z.enum(['pr', 'ci']).optional(),
});
export type Buzz = z.infer<typeof BuzzSchema>;
