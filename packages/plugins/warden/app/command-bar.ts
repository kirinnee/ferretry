import { type DestinationDecl, destinationCommands } from '@ferretry/app';

/**
 * Warden's place in the command bar (`shell.commands`), in v4's words.
 */
export const wardenCommands = destinationCommands('warden', [
  {
    screen: 'warden',
    label: 'Warden',
    description: 'Open fleet supervision and verdicts',
    keywords: ['supervision', 'verdicts', 'ai login', 'ai logins', 'failover', 'quota'],
    order: 60,
  },
] satisfies readonly DestinationDecl[]);
