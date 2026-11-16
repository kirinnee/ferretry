/**
 * Codex's answer to Runtimes' profile component source (`@ferretry/plugin-runtimes/contract`): the `settings` components a
 * profile layer names for a Codex runtime are this plugin's `config/codex/settings/<name>.yaml` items, read live from the
 * kernel's configuration.
 *
 * A projection of the item as it is in effect: the harness it is for, the document as parsed data and its launch `flags`
 * when it has any. No file text is read
 * or kept. A secret in a settings value is a `${secret:NAME}` reference exactly as the file holds it. The `hooks` components
 * are this plugin's `config/codex/hooks/<name>.yaml` items; Runtimes renders them as the runtime's `hooks.json`.
 */
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import type { HooksItem, SettingsItem } from '../../contract/index.ts';

export function codexSettingsSource(
  items: () => ReadonlyMap<string, SettingsItem>,
  watch?: ProfileComponentSource['watch'],
): ProfileComponentSource {
  return {
    ...(watch === undefined ? {} : { watch }),
    list: async () => [...items().keys()].toSorted((left, right) => left.localeCompare(right)),
    read: async name => {
      const item = items().get(name);
      // The item's launch flags ride with it: Runtimes' model holds them as the component's `flags` (a layer's flags append).
      return item === undefined
        ? undefined
        : structuredClone({
            harness: 'codex',
            document: item.settings,
            ...(item.flags === undefined || item.flags.length === 0 ? {} : { flags: item.flags }),
          });
    },
  };
}

export function codexHooksSource(
  items: () => ReadonlyMap<string, HooksItem>,
  watch?: ProfileComponentSource['watch'],
): ProfileComponentSource {
  return {
    ...(watch === undefined ? {} : { watch }),
    list: async () => [...items().keys()].toSorted((left, right) => left.localeCompare(right)),
    read: async name => {
      const item = items().get(name);
      return item === undefined ? undefined : structuredClone({ harness: 'codex', document: { hooks: item.hooks } });
    },
  };
}
