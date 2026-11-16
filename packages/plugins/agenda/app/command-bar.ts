import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Agenda's place in the command bar (`shell.commands`). v4 called it the Inbox; its words are kept.
 */
export const agendaCommands = destinationCommands('agenda', [
  {
    screen: 'agenda',
    label: 'Agenda',
    description: 'Everything your ferrets are waiting on you for, across every machine',
    keywords: ['inbox', 'attention', 'asks', 'questions', 'waiting', 'unread'],
    order: 10,
  },
] satisfies readonly DestinationDecl[]);
