/**
 * The owning plugin supplies each item kind (design §4.9; lead-approved additive seam).
 * Methods and file guards are today's catalog installer/publisher ports, split by kind.
 * A provider is called only after Catalogs' signature, preview, person and passkey checks.
 * Absence refuses that kind; it never grants access or supplies an empty inventory as truth.
 */
import { defineHook } from '@ferretry/kernel/contract';
import type { CallerGovernance, CapabilityPresentation } from '@ferretry/core-gate/contract';
import { z } from 'zod';
import { CatalogItemKindSchema } from '../wire.ts';
import type { CatalogProvenance, CatalogSkillFile } from '../wire/index.ts';
import type { SkillTreePort, McpSourceServer } from './sources.ts';
import type { ProjectSkillFiles, RuntimeSkillAssets } from './skill-files.ts';
import type { McpProjectFiles } from './mcp-files.ts';
export * from './sources.ts';
export * from './skill-files.ts';
export * from './mcp-files.ts';

/** Exactly today's apply witness; a provider must enforce it, never infer it from an actor label. */
export interface FreshStepUpContext {
  readonly presentation: CapabilityPresentation | undefined;
  readonly spend: () => void;
  readonly agent: boolean;
}
export interface CatalogRuntimeTarget {
  readonly id: string;
  readonly name: string;
  readonly profile: string;
  readonly harness: 'claude' | 'codex';
}
export interface CatalogProfileTarget {
  readonly name: string;
}
export type CatalogInstallComponent =
  | {
      readonly kind: 'mcp';
      readonly command?: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly url?: string;
      readonly auth?: 'oauth';
    }
  | { readonly kind: 'skills'; readonly items: readonly string[] };
export interface CatalogInstallChange {
  readonly kind: 'catalog.install';
  readonly name: string;
  readonly component: CatalogInstallComponent;
  readonly files: readonly CatalogSkillFile[];
  readonly profile: string;
  readonly installedFrom: CatalogProvenance;
  readonly replace: boolean;
}
/** Per-kind runtime writes use the same proposal/revision and apply paths the owner plugin already owns. */
export interface CatalogRuntimeInstaller {
  runtimes(): Promise<{ readonly runtimes: readonly CatalogRuntimeTarget[] }>;
  profiles(): Promise<{ readonly profiles: readonly CatalogProfileTarget[] }>;
  /** The whole stored record, for internal edit hashing only; never a route answer. */
  storedComponent(name: string): Promise<unknown>;
  propose(change: {
    readonly kind: 'component.remove';
    readonly name: string;
    readonly removeFromProfiles: true;
  }): Promise<{ readonly id: string }>;
  apply(id: string, governance: CallerGovernance | undefined, fresh: FreshStepUpContext): Promise<unknown>;
  installCatalogItem(
    change: CatalogInstallChange,
    governance: CallerGovernance | undefined,
  ): Promise<{ readonly component: unknown }>;
}
export interface CatalogSkillProvider {
  readonly kind: 'skill';
  sources(): Promise<readonly { readonly path: string; readonly name: string }[]>;
  readonly tree: SkillTreePort;
  projectRoots(): Promise<readonly string[]>;
  readonly project: ProjectSkillFiles;
  readonly assets: RuntimeSkillAssets;
  readonly runtime: CatalogRuntimeInstaller;
}
export interface CatalogMcpProvider {
  readonly kind: 'mcp';
  sources(): Promise<readonly McpSourceServer[]>;
  projectRoots(): Promise<readonly string[]>;
  readonly project: McpProjectFiles;
  readonly runtime: CatalogRuntimeInstaller;
}
export type CatalogItemProvider = CatalogSkillProvider | CatalogMcpProvider;
/** Catalogs consumes providers; each owning plugin takes its key in this hook. */
export const CatalogItems = defineHook('catalog.items', {
  mode: 'provide',
  key: CatalogItemKindSchema,
  value: z.custom<CatalogItemProvider>(),
});

/**
 * A provider's refusal of one install, removal or read, carrying today's code and sentence. Catalogs answers it as
 * the fleet change it always was: `fleet_change_unknown` is 404, any other code is 409. A provider throws this
 * instead of an `ApiError` so the answer keeps today's code whichever plugin owns the kind.
 */
export class CatalogItemRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogItemRefusal';
  }
}
