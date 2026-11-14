import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Projects' place in the command bar (`shell.commands`), in v4's words: the registered workspaces and folders.
 */
export const projectsCommands = destinationCommands('projects', [
  {
    screen: 'projects',
    label: 'Projects',
    description: 'Open registered workspaces and folders',
    keywords: ['project', 'workspace', 'folder', 'repository', 'repo'],
    order: 35,
  },
] satisfies readonly DestinationDecl[]);
