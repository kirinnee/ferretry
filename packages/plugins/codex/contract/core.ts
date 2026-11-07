/**
 * LOCAL STAND-INS for the core contracts that are still being written on `rebuild/spine-core-contracts`
 * (docs/rebuild/spine.md §9 slice 3). Names follow the hook table of the design (§3.5) and the port names of §2.2.
 *
 * WHEN THE CORE CONTRACTS LAND: delete this file and import the same names from `@ferretry/core-gate/contract`,
 * `@ferretry/core-ferrets/contract` and `@ferretry/core-vault/contract`. Nothing else in this plugin names a core
 * type, so the swap is one file plus its import lines. A hook is matched by NAME (`harnesses`, `logins`,
 * `launch.parts`), so a stand-in with the right name builds the same graph.
 */
import { z } from 'zod';
import {
  type CapabilityAxis,
  type CapabilityDemand,
  type ConfigDef,
  defineHook,
  definePort,
  type FerretId,
  policyRef,
} from '@ferretry/kernel/contract';

// Gate: the capability vocabulary and the audit kinds (today's `AuditEvent` names) ──────────────────────────────────

export type GateCapability = 'fleet' | 'terminal' | 'browser' | 'filesystem' | 'warden' | 'pairing' | 'secrets';

/** `cap('fleet', 'configure')`: the operator's narrower question, asked after the credential class. */
export function cap(capability: GateCapability, axis: CapabilityAxis): CapabilityDemand {
  return { capability: policyRef('capability', capability), axis };
}

/** An audit kind: today's event name (`fleet.configured`, `terminal.input`), optionally `:<detail>` for its `mode`/`action`. */
export function audit(kind: string) {
  return { record: policyRef('audit', kind) } as const;
}

// Ferrets: ids and the hooks a ferret part takes ────────────────────────────────────────────────────────────────────

export type { FerretId };

/** `harnesses` (provide, security path; takers: claude-code, codex). The value is Ferrets' `Harness` (§4.3). */
export const Harnesses = defineHook('harnesses', {
  mode: 'provide',
  key: z.string(),
  value: z.custom<unknown>(),
  takers: ['claude-code', 'codex'],
});

/** `logins` (provide, security path; takers: logins). The value is Ferrets' `LoginKind` (§4.4). */
export const Logins = defineHook('logins', {
  mode: 'provide',
  key: z.string(),
  value: z.custom<unknown>(),
  takers: ['logins'],
});

/** `launch.parts` (contribute): instructions, tools, shell, login, MCP servers and skills a start is built from. */
export const LaunchParts = defineHook('launch.parts', { mode: 'contribute', item: z.custom<unknown>() });

// Ports other plugins build against (`needs`) ───────────────────────────────────────────────────────────────────────

/** Vault's port, as far as a plugin that only USES secrets by name sees it (no getter exists, by design). */
export interface VaultApi {
  /** Whether a secret of this name is held. Never its value. */
  has(name: string): Promise<boolean>;
}
export const VaultPort = definePort<VaultApi>('vault');

/** Ferrets' port, as far as Runtimes needs it. */
export interface FerretsApi {
  /** The harness keys currently provided under `harnesses`. */
  harnesses(): readonly string[];
}
export const FerretsPort = definePort<FerretsApi>('ferrets');

/** Ferrets' harness key (§4.3): the id of a harness plugin. Today's wire said `claude`; the key is the plugin id. */
export const HarnessKeySchema = z.enum(['claude-code', 'codex']);
export type HarnessKey = z.infer<typeof HarnessKeySchema>;

/**
 * The leaf's `ConfigDef` (= `ConfigDef<unknown>`) does not accept a typed `defineConfig(...)` result, because
 * `Loosens<Shape>` is invariant in `Shape`. `manifest.data.config` wants `ConfigDef[]`, so a contract widens its defs
 * through this. (Reported to the lead as a leaf wart: `Loosens<any>` in `ConfigDef` would remove the need.)
 */
export function configDef(def: ConfigDef<any>): ConfigDef {
  return def as ConfigDef;
}
