import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/** PRs & CI's place in the command bar (`shell.commands`): every project's open pull requests and their checks. */
export const pullsCommands = destinationCommands('pulls', [
  {
    screen: 'pulls',
    label: 'PRs & CI',
    description: 'Open pull requests and their checks, per project',
    keywords: ['pull request', 'pr', 'ci', 'checks', 'github', 'review'],
    order: 37,
  },
] satisfies readonly DestinationDecl[]);
