import type { HarnessKey, LaunchPart } from '@ferretry/core-ferrets/contract';
import type { JsonValue } from '@ferretry/std';
import { McpEnvSchema, type McpItem } from '../../contract/index.ts';

/**
 * The `launch.parts` a launch gets from `config/mcp/*.yaml` (§4.9): one `mcp` part per item the harness may run (an
 * item that names a harness is for that harness only). Inert: a part is a name and the item as data. `env` keeps its
 * `${secret:NAME}` references; the Vault opens them for the child at the moment it starts, so no value is here.
 */
export function mcpParts(items: ReadonlyMap<string, McpItem>, harness: HarnessKey): readonly LaunchPart[] {
  const parts: LaunchPart[] = [];
  for (const [name, item] of [...items].sort(([left], [right]) => left.localeCompare(right))) {
    if (item.harness !== undefined && item.harness !== harness) continue;
    if (item.env !== undefined && !McpEnvSchema.safeParse(item.env).success)
      throw new Error(
        `The MCP server environment is invalid. Store credentials with fy secret set NAME and use \${secret:NAME}.`,
      );
    const { harness: _harness, ...config } = item;
    parts.push({ kind: 'mcp', name, config: config as JsonValue });
  }
  return parts;
}
