/**
 * Skills' answer to Runtimes' profile component source (`@ferretry/plugin-runtimes/contract`): the `skills` components a
 * profile layer names are this plugin's `config/skills/<name>.yaml` items (a selection of skill item names), read live from
 * the kernel's configuration.
 *
 * A projection of the item as it is in effect: plain parsed data, names only. No skill folder or file text is read here and
 * nothing is kept between reads.
 */
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import type { SkillsItem } from '../../contract/index.ts';

export function skillsComponentSource(
  items: () => ReadonlyMap<string, SkillsItem>,
  watch?: ProfileComponentSource['watch'],
): ProfileComponentSource {
  return {
    ...(watch === undefined ? {} : { watch }),
    list: async () => [...items().keys()].toSorted((left, right) => left.localeCompare(right)),
    read: async name => {
      const item = items().get(name);
      return item === undefined ? undefined : structuredClone({ ...item });
    },
  };
}
