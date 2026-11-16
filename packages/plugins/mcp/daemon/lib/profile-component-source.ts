/**
 * MCP's answer to Runtimes' profile component source (`@ferretry/plugin-runtimes/contract`): the `mcp` components a profile
 * layer names are this plugin's `config/mcp/<name>.yaml` items, read live from the kernel's configuration.
 *
 * A projection of the item as it is in effect: plain parsed data, no file text. Its environment and a hand-registered
 * client secret are `${secret:NAME}` references exactly as the file holds them (the item schema refuses a raw secret), so
 * no secret value is ever here to leak. Nothing is kept between reads.
 */
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import type { McpItem } from '../../contract/index.ts';

export function mcpComponentSource(
  items: () => ReadonlyMap<string, McpItem>,
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
