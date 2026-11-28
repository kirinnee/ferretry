/**
 * The two harness plugins' settings sources as a composed daemon mounts them, each carrying its REAL kit (a Claude
 * runtime is written only from Claude's kit, so a daemon composed without one refuses it by name).
 */
import { type DaemonImplementation, definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import {
  PROFILE_COMPONENTS_KEY,
  ProfileClaudeSettingsSource,
  ProfileCodexSettingsSource,
} from '../../contract/index.ts';
import { REAL_KITS } from './real-kits.ts';

export function settingsOwners(): DaemonImplementation<any>[] {
  return (
    [
      ['claude-code', ProfileClaudeSettingsSource, 'runtimes.components.settings.claude:components', 'claude'],
      ['codex', ProfileCodexSettingsSource, 'runtimes.components.settings.codex:components', 'codex'],
    ] as const
  ).map(
    ([id, hook, name, harness]) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook, key: PROFILE_COMPONENTS_KEY }] },
        }),
        {
          build: () => ({
            hooks: { [name]: { kit: REAL_KITS.get(harness), list: async () => [], read: async () => undefined } },
          }),
        } as never,
      ) as DaemonImplementation<any>,
  );
}
