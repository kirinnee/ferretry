import { deviceSettingsHref, type PluginCommandSource } from '@ferretry/app';
import { whatsNewRequests } from './lib/whats-new-requests.ts';

/**
 * THE COMMAND BAR'S WAY TO "WHAT'S NEW" (today's finder entry): somebody who types "changelog" or "release notes" is taken
 * to Settings › This device, where the panel opens the one sheet. It needs nothing from the daemon, so it lists from the
 * first keystroke and never calls `changed`.
 */
export const whatsNewCommands: PluginCommandSource =
  ({ daemon, navigate }) =>
  () => [
    {
      id: 'updates-whats-new',
      group: 'Settings',
      label: 'What’s new',
      description: 'The latest changes to Ferretry, newest first.',
      keywords: ['changelog', 'release notes', 'releases', 'updates', 'new', 'version'],
      run: () => {
        whatsNewRequests.request();
        navigate(deviceSettingsHref(daemon));
      },
    },
  ];
