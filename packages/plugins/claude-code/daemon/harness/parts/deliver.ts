import type { Delivery, FerretId, OutboundMessage, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import { type ClaudeCore, type Serves, TMUX_TIMEOUT_MS } from './core.ts';

async function tmux(core: ClaudeCore, args: readonly string[]): Promise<Result<true, string>> {
  try {
    const result = await core.deps.spawn.run('tmux', args, { timeout: milliseconds(TMUX_TIMEOUT_MS) });
    return result.exitCode === 0
      ? ok(true)
      : err(result.stderr.trim() || `tmux exited ${String(result.exitCode ?? result.signal)}`);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

export const deliverPart = (core: ClaudeCore): Serves<'deliver'> => ({
  /** Idempotent by message id: delivering one id twice delivers it once. */
  async deliver(ferret: FerretId, handle: RunnerHandle, message: OutboundMessage): Promise<Delivery> {
    if (core.delivered.has(message.id)) return { status: 'delivered', id: message.id };
    core.deps.panes.remember(ferret, handle);
    const text = [message.text, ...(message.attachments ?? []).map(path => `@${path}`)].join('\n');
    const typed = await tmux(core, ['send-keys', '-t', handle, '-l', '--', text]);
    if (!typed.ok) return { status: 'refused', id: message.id, reason: typed.error };
    const entered = await tmux(core, ['send-keys', '-t', handle, 'Enter']);
    if (!entered.ok) return { status: 'refused', id: message.id, reason: entered.error };
    core.delivered.add(message.id);
    return { status: 'delivered', id: message.id };
  },
});
