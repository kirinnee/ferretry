import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Usage's place in the command bar (`shell.commands`). v4 called it Analytics; its words are kept as search words.
 */
export const usageCommands = destinationCommands('usage', [
  {
    screen: 'insights',
    label: 'Insights',
    description: 'Query all ferrets and graph daily usage',
    keywords: ['analytics', 'usage', 'cost', 'spend', 'tokens', 'graph', 'chart', 'query', 'daily'],
    order: 50,
  },
] satisfies readonly DestinationDecl[]);
