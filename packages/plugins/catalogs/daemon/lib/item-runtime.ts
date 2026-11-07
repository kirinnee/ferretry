import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { CatalogRuntimeTarget, CatalogProfileTarget, CatalogInstallChange } from '../../contract/items/index.ts';
export type { FreshStepUpContext } from '../../contract/items/index.ts';
import type { FreshStepUpContext } from '../../contract/items/index.ts';
/** Today's installer calls, routed to the provider of the named kind. */
export interface ItemRuntime {
  runtimes(): Promise<{ readonly runtimes: readonly CatalogRuntimeTarget[] }>;
  profiles(): Promise<{ readonly profiles: readonly CatalogProfileTarget[] }>;
  storedComponent(kind: 'mcp' | 'skills', name: string): Promise<unknown>;
  propose(change: {
    readonly kind: 'component.remove';
    readonly componentKind: 'mcp' | 'skills';
    readonly name: string;
    readonly removeFromProfiles: true;
  }): Promise<{ readonly id: string }>;
  apply(id: string, governance: CallerGovernance | undefined, fresh: FreshStepUpContext): Promise<unknown>;
  installCatalogItem(
    change: CatalogInstallChange,
    governance: CallerGovernance | undefined,
  ): Promise<{ readonly component: unknown }>;
}
