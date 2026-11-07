/** Who needs whom, read from the manifests' `needs` and `uses` tokens (§2.4). Pure. */
import type { CommandRegistry } from './registry.ts';

export interface PluginEdges {
  /** Plugins whose port this plugin cannot run without. */
  readonly needs: readonly string[];
  /** Plugins whose port this one uses when present. */
  readonly uses: readonly string[];
}

export interface PluginGraph {
  edges(id: string): PluginEdges;
  /** Plugins that need `id`, directly or through another plugin (turning `id` off stops them). */
  dependentsOf(id: string): readonly string[];
  /** Plugins that only use `id` when present (turning `id` off degrades them, it does not stop them). */
  usersOf(id: string): readonly string[];
}

export function buildPluginGraph(registry: CommandRegistry): PluginGraph {
  const providers = new Map<string, string>();
  for (const plugin of registry.plugins)
    for (const token of Object.values(plugin.manifest.provides ?? {}))
      if (!providers.has(token.name)) providers.set(token.name, plugin.id);
  const edgesById = new Map<string, PluginEdges>();
  const resolve = (tokens: Readonly<Record<string, { readonly name: string }>> | undefined, self: string): string[] =>
    [...new Set(Object.values(tokens ?? {}).map(token => providers.get(token.name)))].filter(
      (id): id is string => id !== undefined && id !== self,
    );
  for (const plugin of registry.plugins)
    edgesById.set(plugin.id, {
      needs: resolve(plugin.manifest.needs, plugin.id),
      uses: resolve(plugin.manifest.uses, plugin.id),
    });
  const none: PluginEdges = { needs: [], uses: [] };
  const edges = (id: string): PluginEdges => edgesById.get(id) ?? none;
  return {
    edges,
    dependentsOf(id) {
      const found = new Set<string>();
      const visit = (target: string): void => {
        for (const plugin of registry.plugins)
          if (!found.has(plugin.id) && edges(plugin.id).needs.includes(target)) {
            found.add(plugin.id);
            visit(plugin.id);
          }
      };
      visit(id);
      return [...found].sort();
    },
    usersOf(id) {
      return registry.plugins
        .filter(plugin => edges(plugin.id).uses.includes(id))
        .map(plugin => plugin.id)
        .sort();
    },
  };
}
