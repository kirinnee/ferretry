/**
 * @ferretry/plugin-codex/contract — wire schemas, port + token, events, state and config declarations, words.
 * Codex is a harness (§4.3): it takes `harnesses:codex` from Ferrets and offers nothing but a read port.
 */
import { InstantSchema } from '@ferretry/std';
import {
  defineConfig,
  defineEvent,
  definePort,
  defineState,
  type Loosens,
  neverLoosens,
} from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import {
  DiscoverySchema,
  HarnessConfigSchema,
  type Discovery,
  type HarnessCliView,
  type HarnessConfig,
  SettingsItemSchema,
} from './wire.ts';

export * from './wire.ts';

/** The harness key and plugin id. */
export const CODEX = 'codex' as const;

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What others (Updates, Onboarding, the app) may read about this harness. The harness itself is offered through Ferrets' `harnesses` hook. */
export interface CodexApi {
  /** Where `claude` is, how it was installed, whether Ferretry verified its version. Asks npm only when someone looks. */
  view(): Promise<HarnessCliView>;
  /** What discovery last found; `undefined` before the first look. Never reads the harness's sign-in files. */
  discovery(): Promise<Discovery | undefined>;
}
export const CodexPort = definePort<CodexApi>('codex');

/** Read models others may call (`manifest.data.readModels`). */
export const CODEX_READ_MODELS = ['view', 'discovery'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** An update of `claude` ended (after its write). */
export const CodexUpdateFinished = defineEvent(
  'codex.update-finished',
  z.strictObject({ outcome: z.enum(['succeeded', 'unchanged', 'rolled-back', 'failed']), finishedAt: InstantSchema }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Codex's own per-ferret home format. Ferretry writes inside it and never reads its sign-in files. */
export const CODEX_AGENT_HOMES = defineState({
  name: 'agentHomes',
  path: 'agent-homes/*',
  store: 'opaque',
  format: 1,
});

export const CODEX_DISCOVERY = defineState({
  name: 'discovery',
  path: 'discovery.json',
  store: 'json',
  format: 1,
  schema: DiscoverySchema,
});

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

/** Today's `machineLoosening` rule for the permission mode, kept word for word. */
export const harnessConfigLoosens: Loosens<HarnessConfig> = (before, after) =>
  (before?.permissionMode ?? 'auto') === 'auto' && after.permissionMode === 'skip'
    ? ['agents now skip every permission prompt']
    : [];

/** `config/harness-codex.yaml`: the binary, the search directories and the permission mode. */
export const CODEX_CONFIG = configDef(
  defineConfig({
    file: 'harness-codex.yaml',
    schema: HarnessConfigSchema,
    axis: 'configure',
    loosens: harnessConfigLoosens,
  }),
);

const ITEM_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** `config/codex/settings/<name>.yaml`. Today a component edit changes what an agent runs with, never what it may spend. */
export const CODEX_SETTINGS = configDef(
  defineConfig({
    collection: 'codex/settings',
    name: ITEM_NAME,
    schema: SettingsItemSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);
