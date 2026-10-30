import type { Command } from 'commander';
import type { IQueueGateway, IQueueOutput } from './ports.ts';
import { renderQueue } from './render.ts';

interface QueueOptions {
  readonly json?: boolean | undefined;
}

/** Everything a queue command needs besides its arguments and flags. */
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

const QUEUE_HELP = `A message can be changed only while it waits (✓). Once it is typed into the ferret it is the ferret's.

  fy queue <ferret>                      list the queue
  fy queue edit <ferret> <id> <text...>  new words for a waiting message
  fy queue cancel <ferret> <id>          take back a waiting message`;

/** Mounts `fy queue` and its `edit` and `cancel` onto the program. */
export function registerQueueCommands(program: Command, ports: QueuePorts): void {
  const queue = program
    .command('queue')
    .description("list a ferret's message queue: ✓ queued, ✓✓ delivered, ✓✓✓ read, and why a message waits")
    .argument('<ferret>', 'the ferret, by name or session id')
    .option('--json', 'print the queue as JSON')
    .addHelpText('after', `\n${QUEUE_HELP}`)
    .action(async (ferret: string, options: QueueOptions) => {
      await runQueue(ports, ferret, options);
    });

  queue
    .command('edit')
    .description('replace the words of a message that is still waiting')
    .argument('<ferret>', 'the ferret, by name or session id')
    .argument('<id>', 'the message id, as `fy queue <ferret>` lists it')
    .argument('<text...>', 'the new words')
    .action(async (ferret: string, id: string, words: string[]) => {
      const edited = await ports.gateway.edit(ferret, id, words.join(' '));
      ports.out.report(`Edited ${edited.id} (revision ${String(edited.revision)}). It still waits its turn.`);
    });

  queue
    .command('cancel')
    .description('take back a message that is still waiting; nothing of it was typed')
    .argument('<ferret>', 'the ferret, by name or session id')
    .argument('<id>', 'the message id, as `fy queue <ferret>` lists it')
    .action(async (ferret: string, id: string) => {
      const cancelled = await ports.gateway.cancel(ferret, id);
      ports.out.report(`Cancelled ${cancelled.id}. The ferret never saw it.`);
    });
}
