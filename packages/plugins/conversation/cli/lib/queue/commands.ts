import type { VerbHandler } from '@ferretry/kernel/manifest';
import type { QueueGateway, QueueOutput } from './ports.ts';
import { renderQueue } from './render.ts';

/** Everything a queue command needs besides its arguments and flags. */
export interface QueuePorts {
  readonly gateway: QueueGateway;
  readonly out: QueueOutput;
}

const usage = (ports: QueuePorts, line: string): number => {
  ports.out.report(`usage: ${line}`);
  return 2;
};

/** `fy queue <ferret> [--json]`: what is waiting to reach a ferret, and what already did. */
export const queueVerb =
  (ports: QueuePorts): VerbHandler =>
  async invocation => {
    const [ferret] = invocation.args;
    if (ferret === undefined) return usage(ports, 'fy queue <ferret> [--json]');
    const messages = await ports.gateway.messages(ferret);
    if (invocation.options.json === true) ports.out.report(JSON.stringify({ messages }, null, 2));
    else for (const line of renderQueue(messages)) ports.out.report(line);
    return 0;
  };

/** `fy queue edit <ferret> <id> <text...>`. */
export const queueEditVerb =
  (ports: QueuePorts): VerbHandler =>
  async invocation => {
    const [ferret, id, ...words] = invocation.args;
    if (ferret === undefined || id === undefined || words.length === 0)
      return usage(ports, 'fy queue edit <ferret> <id> <text...>');
    const edited = await ports.gateway.edit(ferret, id, words.join(' '));
    ports.out.report(`Edited ${edited.id} (revision ${String(edited.revision)}). It still waits its turn.`);
    return 0;
  };

/** `fy queue cancel <ferret> <id>`. */
export const queueCancelVerb =
  (ports: QueuePorts): VerbHandler =>
  async invocation => {
    const [ferret, id] = invocation.args;
    if (ferret === undefined || id === undefined) return usage(ports, 'fy queue cancel <ferret> <id>');
    const cancelled = await ports.gateway.cancel(ferret, id);
    ports.out.report(`Cancelled ${cancelled.id}. The ferret never saw it.`);
    return 0;
  };
