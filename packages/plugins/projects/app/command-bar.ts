import { type DestinationDecl, destinationCommands, type PluginCommandContext } from '@ferretry/app';
import { goToFileSource } from './features/file-finder/go-to-file.ts';

/**
 * Projects' place in the command bar (`shell.commands`), in v4's words: the registered workspaces and folders. Two
 * sources: the place (answers at once) and "Go to file", which exists only on a project's own page (&F6061 U7).
 */
const projectsPlaces = destinationCommands('projects', [
  {
    screen: 'projects',
    label: 'Projects',
    description: 'Open registered workspaces and folders',
    keywords: ['project', 'workspace', 'folder', 'repository', 'repo'],
    order: 35,
  },
] satisfies readonly DestinationDecl[]);

const goToFile = goToFileSource();

export const projectsCommands = (context: PluginCommandContext) => [projectsPlaces(context), goToFile(context)];
