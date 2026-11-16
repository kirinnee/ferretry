/**
 * What Runtimes answers, as MCP's inventory and launch read it: the published accounts (one per runtime that launches
 * into a home) and the runtimes whose profile stack carries each MCP item. Read live, per call; Runtimes off answers
 * nothing (no accounts, no component carried by any runtime).
 */
import type { RuntimeHome, RuntimesApi, RuntimeId } from '@ferretry/plugin-runtimes/contract';
import type { McpItem } from '../../../contract/index.ts';
import type { McpInventoryAccount, McpInventoryComponent } from './service.ts';

/** The slice of Runtimes this wiring reads. */
export type RuntimesView = Pick<RuntimesApi, 'homes' | 'list' | 'layers'>;

/** One account per runtime name a published home lists, in manifest order. */
export function accountsOf(homes: readonly RuntimeHome[]): readonly McpInventoryAccount[] {
  return homes.flatMap(home =>
    home.runtimes.map(runtime => ({
      runtime,
      harness: home.harness,
      home: home.home,
      wrapper: home.wrapper,
      ...(home.secretEnv === undefined ? {} : { secretEnv: home.secretEnv }),
    })),
  );
}

/**
 * The MCP item names a runtime's profile stack names, or an empty set for a runtime that is unknown or whose stack
 * cannot be resolved (a base that does not exist, a loop): never a guess, so nothing is carried.
 */
export async function layeredMcp(
  runtimes: RuntimesView | undefined,
  runtime: string | undefined,
): Promise<ReadonlySet<string>> {
  if (runtimes === undefined || runtime === undefined) return new Set();
  try {
    const layers = await runtimes.layers(runtime as RuntimeId);
    return new Set(layers?.mcp ?? []);
  } catch {
    return new Set();
  }
}

/** Each item with the runtimes whose profile stack carries it (`McpInventoryComponent.runtimes`). */
export async function componentsOf(
  items: ReadonlyMap<string, McpItem>,
  runtimes: RuntimesView | undefined,
): Promise<readonly McpInventoryComponent[]> {
  const names = runtimes === undefined ? [] : (await runtimes.list()).map(summary => summary.id);
  const carried = await Promise.all(names.map(async name => [name, await layeredMcp(runtimes, name)] as const));
  return [...items].map(([name, item]) => ({
    name,
    runtimes: carried.filter(([, set]) => set.has(name)).map(([runtime]) => runtime),
    ...(item.auth === undefined ? {} : { auth: item.auth }),
  }));
}
