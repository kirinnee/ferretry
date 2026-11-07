/**
 * Access's wire (§2.1) beyond today's protocol files: what other plugins hand Access, and Access's own state file.
 * The route bodies are copied from today's `packages/protocol/src/lib/{pairing,push,step-up,grants}.ts` into
 * `pairing.ts`, `push.ts`, `step-up.ts` and `grants.ts` beside this file.
 *
 * THERE IS NO DEVICE TOKEN, AND NO SCHEMA FOR ONE. A paired device proves itself by signing each session's
 * transcript with a key it cannot export; the daemon holds only the public half, and no view here carries it.
 */
import { z } from 'zod';

/** One buzz as another plugin hands it to Access (Agenda's `uses`): words only, never a secret. */
export const BuzzSchema = z.strictObject({
  tag: z.string().min(1).max(200),
  title: z.string().min(1),
  body: z.string(),
  url: z.string().min(1),
});
export type Buzz = z.infer<typeof BuzzSchema>;
