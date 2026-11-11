/**
 * What the agent tool door's guard needs of the command registry, without the registry: each package's compiled contract
 * hash and title, and which package owns each tool and who may call it. Generated beside the registry
 * (`src/generated/slim.ts`) from the same manifests, so `fy mcp serve` can check a call exactly as the full router does
 * (§9.6) while loading no manifest.
 */
import { type Surfaces, toolKey } from '../client.ts';

interface ToolDoorTool {
  /** The owning package. */
  readonly plugin: string;
  readonly name: string;
  readonly caller: 'person' | 'any';
}

export interface ToolDoor {
  /** The effective contract hash of every package the registry holds, the Kernel included. */
  readonly contracts: Readonly<Record<string, string>>;
  readonly titles: Readonly<Record<string, string>>;
  readonly tools: readonly ToolDoorTool[];
}

/**
 * The {@link Surfaces} the tool door reads: the same tool facts, titles and contract hashes `surfacesOf(registry)` builds.
 * Routes and sockets are empty because the slim entry calls only tools.
 */
export function toolSurfaces(door: ToolDoor): Surfaces {
  const tools = new Map<string, { owner: string; caller: 'person' | 'any' }>();
  for (const tool of door.tools)
    tools.set(toolKey(tool.plugin, tool.name), { owner: tool.plugin, caller: tool.caller });
  return { routes: new Map(), tools, sockets: new Map(), titles: door.titles, compiled: door.contracts };
}
