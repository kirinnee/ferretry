/**
 * Claude Code's answer to Runtimes' profile component sources (`@ferretry/plugin-runtimes/contract`): the `settings` and
 * `hooks` components a profile layer names for a Claude runtime are this plugin's `config/claude-code/settings/<name>.yaml`
 * and `config/claude-code/hooks/<name>.yaml` items, read live from the kernel's configuration.
 *
 * Each is a projection of the item as it is in effect: the harness it is for and the document as parsed data (a settings
 * document, or a `hooks` block), and a settings item's launch `flags` when it has any. No file text is read or kept. A secret in a settings value is a `${secret:NAME}`
 * reference exactly as the file holds it (the item schema refuses a raw secret).
 */
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import type { HooksItem, SettingsItem } from '../../contract/index.ts';

const byName = (left: string, right: string): number => left.localeCompare(right);

export function claudeSettingsSource(
  items: () => ReadonlyMap<string, SettingsItem>,
  watch?: ProfileComponentSource['watch'],
): ProfileComponentSource {
  return {
    ...(watch === undefined ? {} : { watch }),
    list: async () => [...items().keys()].toSorted(byName),
    read: async name => {
      const item = items().get(name);
      // The item's launch flags ride with it: Runtimes' model holds them as the component's `flags` (a layer's flags append).
      return item === undefined
        ? undefined
        : structuredClone({
            harness: 'claude-code',
            document: item.settings,
            ...(item.flags === undefined || item.flags.length === 0 ? {} : { flags: item.flags }),
          });
    },
  };
}

export function claudeHooksSource(
  items: () => ReadonlyMap<string, HooksItem>,
  watch?: ProfileComponentSource['watch'],
): ProfileComponentSource {
  return {
    ...(watch === undefined ? {} : { watch }),
    list: async () => [...items().keys()].toSorted(byName),
    read: async name => {
      const item = items().get(name);
      return item === undefined
        ? undefined
        : structuredClone({ harness: 'claude-code', document: { hooks: item.hooks } });
    },
  };
}
