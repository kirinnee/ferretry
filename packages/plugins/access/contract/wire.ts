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
});
export type Buzz = z.infer<typeof BuzzSchema>;
