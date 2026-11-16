import { daemonSettingsHref, type PluginCommandSource } from '@ferretry/app';

/**
 * THE COMMAND BAR'S WAY TO THE CONFIGURATION FILES (today's `settings-catalog.ts` entry `files`, "Configuration files"):
 * somebody who types "yaml", "config" or a file's name is taken to this machine's Files tab. The words are today's — the
 * file names themselves, and "yaml" and "config", which is what a person who edits files by hand calls them.
 *
 * It needs nothing from the daemon, so it lists from the first keystroke and never calls `changed`.
 */
const CONFIG_FILES_KEYWORDS = [
  'yaml',
  'config',
  'configuration',
  'files',
  'file',
  'edit as yaml',
  'machine.yaml',
  'warden.yaml',
  'learning.yaml',
  'voice.yaml',
  'logins',
  'profiles',
  'runtimes',
  'components',
  'confirm',
  'waiting',
  'invalid',
] as const;

export const configFilesCommands: PluginCommandSource =
  ({ daemon, navigate }) =>
  () => [
    {
      id: `kernel-config-files-${daemon}`,
      group: 'Settings',
      label: 'Configuration files',
      description:
        'The YAML files this machine’s settings live in: where they are, what is wrong with them, edits waiting for your confirmation, and editing one as YAML.',
      keywords: CONFIG_FILES_KEYWORDS,
      run: () => navigate(daemonSettingsHref(daemon, 'kernel', 'files')),
    },
  ];
