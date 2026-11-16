import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/** Conversation's place in the command bar (`shell.commands`): the kept conversations list. */
export const conversationPlaces = destinationCommands('conversation', [
  {
    screen: 'links',
    label: 'Conversations',
    description: 'Continue a conversation, keep one as a ferret, or read your agent tools’ history',
    keywords: ['conversation', 'history', 'transcripts', 'links', 'continue', 'resume', 'import'],
    order: 25,
  },
] satisfies readonly DestinationDecl[]);
