/**
 * THE QUEUE IN THE COMMAND BAR (`shell.commands`, G6): one "Queue" place that opens the All queues screen, which is
 * where every ferret's waiting messages (and, searched there, the finished ones) are. The screen has no nav entry of its
 * own, so Find would otherwise never offer it. The entry is absent on a daemon whose Conversation has no such screen.
 */
import { type DestinationDecl, destinationCommands } from '@ferretry/app';

export const queueCommands = destinationCommands('conversation', [
  {
    screen: 'queues',
    label: 'Queue',
    description: 'Messages waiting for a ferret’s turn, and the ones it has read',
    keywords: ['queues', 'all queues', 'outbox', 'waiting', 'pending', 'messages', 'sending', 'search messages'],
    order: 20,
  },
] satisfies readonly DestinationDecl[]);
