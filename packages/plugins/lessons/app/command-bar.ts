import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Lessons' place in the command bar (`shell.commands`). v4 called it Learning; its words are kept as search words.
 */
export const lessonsCommands = destinationCommands('lessons', [
  {
    screen: 'lessons',
    label: 'Lessons',
    description: 'Open fleet learning proposals',
    keywords: ['learning', 'proposals', 'rules', 'scan'],
    order: 70,
  },
] satisfies readonly DestinationDecl[]);
