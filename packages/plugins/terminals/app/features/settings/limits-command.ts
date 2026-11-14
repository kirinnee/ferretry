/**
 * THE COMMAND BAR'S WAY TO FERRET LIMITS. The panel is the one somebody looks for when the machine is on fire, so it is
 * found by the words they would actually type at that moment: "slow", "hot", "fan", "swap" and "out of memory" are the
 * SYMPTOMS a person searches by — not "cgroup", the kernel's word for the mechanism, which means nothing to anyone who has
 * not already found the panel.
 */
import { daemonSettingsHref, type PluginCommandSource } from '@ferretry/app';

export const LIMITS_COMMAND = 'terminals-limits';

/** Settings › Terminals › Ferret limits: the tab id the manifest declares. */
const LIMITS_TAB = 'limits';

export const limitsCommands: PluginCommandSource = ({ daemon, navigate }) => {
  const entries = [
    {
      id: `${LIMITS_COMMAND}-${daemon}`,
      group: 'Settings',
      label: 'Ferret limits',
      description: 'How much of the machine the ferrets may take, memory first, and whether that is working.',
      keywords: [
        'cpu',
        'ram',
        'memory',
        'resource',
        'resources',
        'limit',
        'limits.yaml',
        'killed',
        'oom',
        'limits',
        'cap',
        'caps',
        'quota',
        'throttle',
        'cgroup',
        'cgroups',
        'slice',
        'slow',
        'hot',
        'fan',
        'swap',
        'out of memory',
        'runaway',
        'performance',
      ],
      run: () => navigate(daemonSettingsHref(daemon, 'terminals', LIMITS_TAB)),
    },
  ];
  return () => entries;
};
