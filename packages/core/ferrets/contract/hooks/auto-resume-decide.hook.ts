import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema, HarnessKeySchema } from '../ids.ts';
import { DECIDE_ASK_TIMEOUT_MS } from './decide-timeout.ts';

/**
 * What `auto-resume.decide` takers are asked (W2-a, RULING #27 Q5) before the daemon spends anything bringing back a
 * ferret a host restart took down. Two questions, each the one today's pass asked of the account model:
 *
 * - `switch`: is the machine's "Auto-resume after restart" on (today's `machine.autoResume`)? Asked once per pass,
 *   before any ferret. No yes: the pass resumes nothing and forgets what it was owed, as today's switch off did.
 * - `runtime`: can the runtime this ferret ran on serve a launch right now (today's `resolveStartAccount`)? Asked per
 *   ferret, right before its resume. No yes: that ferret is skipped with the reason, and stays down.
 */
export const AutoResumeDecideInputSchema = z.discriminatedUnion('ask', [
  z.strictObject({ ask: z.literal('switch') }),
  z.strictObject({
    ask: z.literal('runtime'),
    ferret: FerretIdSchema,
    harness: HarnessKeySchema,
    runtime: z.string().min(1),
  }),
]);
export type AutoResumeDecideInput = z.infer<typeof AutoResumeDecideInputSchema>;

/**
 * Runtimes answers whether an automatic resume may spend (W2-a). It FAILS CLOSED, unlike `start.decide`: Ferrets
 * resumes only on Runtimes' OWN yes (`AUTO_RESUME_ANSWERER`); no taker, a failed, hung, throwing or garbage answer, or
 * a yes from any other plugin is a no. The wait is the kernel's decide bound, on the kernel clock.
 */
export const AutoResumeDecide = defineHook('auto-resume.decide', {
  mode: 'decide',
  input: AutoResumeDecideInputSchema,
  // Both questions read a file in Runtimes (the switch, the runtime's manifest); a miss here skips the resume (fails closed).
  timeoutMs: DECIDE_ASK_TIMEOUT_MS,
});
