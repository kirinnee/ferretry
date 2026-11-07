import { ApiError } from '@ferretry/kernel/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import {
  CatalogItems,
  type CatalogItemProvider,
  type CatalogMcpProvider,
  type CatalogSkillProvider,
} from '../../contract/items/index.ts';
import type { ItemRuntime } from '../lib/item-runtime.ts';
import type { SkillTreePort } from '../lib/shared-catalogs/skill-source.ts';
import type { ProjectSkillFiles, RuntimeSkillAssets } from '../lib/catalog-installs/ports.ts';
import type { McpProjectFiles } from '../lib/project-mcp.ts';

/** Resolve on each call: an owning plugin that is off or damaged can never leave a usable cached writer. */
export function itemProviders(hooks: HookInvoker) {
  function available(kind: 'skill' | 'mcp'): CatalogItemProvider | undefined {
    const provider = hooks.provider(CatalogItems, kind);
    return provider === 'unavailable' || provider.kind !== kind ? undefined : provider;
  }
  function skill(): CatalogSkillProvider {
    const provider = available('skill');
    if (provider?.kind !== 'skill')
      throw new ApiError(503, 'Skills is not available to publish or install this item.', 'catalog_kind_unavailable');
    return provider;
  }
  function mcp(): CatalogMcpProvider {
    const provider = available('mcp');
    if (provider?.kind !== 'mcp')
      throw new ApiError(503, 'MCP is not available to publish or install this item.', 'catalog_kind_unavailable');
    return provider;
  }
  const runtimeFor = (kind: 'mcp' | 'skills') => (kind === 'mcp' ? mcp() : skill()).runtime;
  const targets = () => {
    const provider = available('skill') ?? available('mcp');
    if (provider === undefined)
      throw new ApiError(503, 'No item provider can read runtime targets.', 'catalog_kind_unavailable');
    return provider.runtime;
  };
  const proposals = new Map<string, { kind: 'mcp' | 'skills'; id: string }>();
  const runtime: ItemRuntime = {
    runtimes: async () => await targets().runtimes(),
    profiles: async () => await targets().profiles(),
    storedComponent: async (kind, name) => await runtimeFor(kind).storedComponent(name),
    propose: async change => {
      const { componentKind, ...proposal } = change;
      const proposed = await runtimeFor(componentKind).propose(proposal);
      const id = `${componentKind}:${proposed.id}`;
      proposals.set(id, { kind: componentKind, id: proposed.id });
      return { id };
    },
    apply: async (id, governance, fresh) => {
      const proposal = proposals.get(id);
      proposals.delete(id);
      if (proposal === undefined)
        throw new ApiError(409, 'The item removal proposal is no longer held.', 'catalog_install_conflict');
      return await runtimeFor(proposal.kind).apply(proposal.id, governance, fresh);
    },
    installCatalogItem: async (change, governance) =>
      await runtimeFor(change.component.kind === 'mcp' ? 'mcp' : 'skills').installCatalogItem(change, governance),
  };
  const tree: SkillTreePort = {
    list: async (...args) => await skill().tree.list(...args),
    read: async (...args) => await skill().tree.read(...args),
  };
  const skillFiles: ProjectSkillFiles = {
    inspect: async (...args) => await skill().project.inspect(...args),
    read: async (...args) => await skill().project.read(...args),
    apply: async (...args) => await skill().project.apply(...args),
  };
  const assets: RuntimeSkillAssets = {
    inspect: async (...args) => await skill().assets.inspect(...args),
    read: async (...args) => await skill().assets.read(...args),
    remove: async (...args) => await skill().assets.remove(...args),
  };
  const mcpFiles: McpProjectFiles = {
    read: async (...args) => await mcp().project.read(...args),
    replace: async (...args) => await mcp().project.replace(...args),
  };
  return {
    skills: { list: async () => await skill().sources() },
    mcp: { servers: async () => await mcp().sources() },
    tree,
    skillFiles,
    assets,
    mcpFiles,
    runtime,
    async projectRoots(): Promise<readonly string[]> {
      const providers = [available('skill'), available('mcp')].filter(
        (provider): provider is CatalogItemProvider => provider !== undefined,
      );
      if (providers.length === 0)
        throw new ApiError(503, 'No item provider can read project targets.', 'catalog_kind_unavailable');
      return [...new Set((await Promise.all(providers.map(async provider => await provider.projectRoots()))).flat())];
    },
  };
}
