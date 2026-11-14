import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Catalogs' places in the command bar (`shell.commands`), in v4's words: Sharing, and the two doors into it that name a
 * tab (what you subscribe to, and publishing skills). The tabs sit right after Sharing itself.
 */
export const catalogsCommands = destinationCommands('catalogs', [
  {
    screen: 'sharing',
    label: 'Sharing',
    description: 'Share skills and MCP servers, see what is shared with you, and who can read your catalogs',
    keywords: ['share', 'catalog', 'catalogs', 'people', 'members', 'skills', 'mcp'],
    order: 40,
  },
  {
    id: 'screen-catalogs.sharing-shared',
    screen: 'sharing',
    params: { tab: 'shared' },
    label: 'Subscriptions',
    description: 'Catalogs you subscribe to, and what you can install from them',
    keywords: [
      'shared',
      'shared with me',
      'received',
      'invite',
      'join',
      'subscribe',
      'install',
      'publisher',
      'catalogs',
    ],
    order: 41,
  },
  {
    id: 'screen-catalogs.sharing-publish',
    screen: 'sharing',
    params: { tab: 'catalogs' },
    label: 'Publish skills…',
    description: 'Put skills from this machine in a catalog others can subscribe to',
    keywords: ['share', 'share a skill', 'skill', 'publish', 'send', 'give', 'catalog'],
    order: 42,
  },
] satisfies readonly DestinationDecl[]);
