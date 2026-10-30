import type { Command } from 'commander';
import type { IQueueGateway, IQueueOutput } from './ports.ts';
import { renderQueue } from './render.ts';

interface QueueOptions {
  readonly json?: boolean | undefined;
}

/** Everything a queue read needs besides its argument and flags. */
export interface QueuePorts {
  readonly gateway: IQueueGateway;
  readonly out: IQueueOutput;
}

/** `fy queue <ferret> [--json]`: what is waiting to reach a ferret, and what already did. */
async function runQueue(ports: QueuePorts, ferret: string, options: QueueOptions): Promise<void> {
  const messages = await ports.gateway.messages(ferret);
  if (options.json === true) {
    ports.out.report(JSON.stringify({ messages }, null, 2));
    return;
  }
  for (const line of renderQueue(messages)) ports.out.report(line);
}

/** Mounts `fy queue` onto the program. */
export function registerQueueCommands(program: Command, ports: QueuePorts): void {
  program
    .command('queue')
    .description("list a ferret's message queue: ✓ queued, ✓✓ delivered, ✓✓✓ read, and why a message waits")
    .argument('<ferret>', 'the ferret, by name or session id')
    .option('--json', 'print the queue as JSON')
    .action(async (ferret: string, options: QueueOptions) => {
      await runQueue(ports, ferret, options);
    });
}
