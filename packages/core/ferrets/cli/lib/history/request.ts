import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { HistoryHarnessSchema } from '../../../contract/conversation-lease.ts';
import { SessionCommandError } from '../session/errors.ts';
import { on, text } from '../verb-io.ts';
import type { HistoryClaimRequest } from './controller.ts';

/**
 * What `fy history claim ...` asked for, or a refusal the caller can act on (exit 2, never the held status 75: a wrapper
 * stops only on that one). The wrapper's own words — `--harness H --pid $$ --from-arguments -- "$@"` — and a person's
 * `fy history claim --harness claude --pid 123 <conversation>` both read here.
 */
export function historyClaimRequest(invocation: VerbInvocation): HistoryClaimRequest {
  const harness = HistoryHarnessSchema.safeParse(text(invocation, 'harness'));
  if (!harness.success) throw new SessionCommandError('--harness is required and is claude or codex');
  const pidText = text(invocation, 'pid');
  const pid = pidText === undefined ? Number.NaN : Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new SessionCommandError('--pid is required and is a positive whole number');
  const words = invocation.args;
  if (on(invocation, 'from-arguments')) return { harness: harness.data, pid, arguments: words };
  return { harness: harness.data, pid, ...(words[0] === undefined ? {} : { conversation: words[0] }) };
}
