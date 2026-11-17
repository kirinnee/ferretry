/**
 * @ferretry/plugin-codex/contract — wire schemas, port + token, events, state and config declarations, words.
 * Codex is a harness (§4.3): it takes `harnesses:codex` from Ferrets and offers nothing but a read port.
 */
import { InstantSchema, ITEM_NAME_PATTERN } from '@ferretry/std';
import {
  type FerretId,
  defineConfig,
  defineEvent,
  definePort,
  defineState,
  type Loosens,
} from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import {
  DiscoverySchema,
  HeldCatalogSchema,
  HarnessConfigSchema,
  type Discovery,
  type HarnessCliView,
  type HarnessConfig,
  type HooksItem,
  HooksItemSchema,
  type SettingsItem,
  SettingsItemSchema,
} from './wire.ts';
import { launchFlagsLoosen } from './launch-flags.ts';

export * from './wire.ts';
export { launchFlagsKept } from './launch-flags.ts';

/** The harness key and plugin id. */
export const CODEX = 'codex' as const;

// ─── project servers (what MCP asks before handing a project server's sign-in to a launch) ───────────────────────

/** What a harness decided about one project server for one ferret. Only `disabled` withholds it. */
export type ProjectServerApproval = 'approved' | 'pending' | 'disabled';

export interface ProjectServerQuery {
  readonly ferret: FerretId;
  /** The folder the servers are declared in; the harness keys its per-project decisions by it. */
  readonly root: string;
  /** The `.mcp.json` server names to answer for. */
  readonly servers: readonly string[];
}

/**
 * `read`: one decision per asked server. `unreadable`: the harness's own documents could not be read, so nobody can
 * tell whether a server was declined. `not-taken`: this harness takes no project server's sign-in at all. A reason
 * names a file or a rule, never a document's contents.
 */
export type ProjectServerApprovals =
  | { readonly state: 'read'; readonly servers: Readonly<Record<string, ProjectServerApproval>> }
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'not-taken'; readonly reason: string };

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What others (Updates, Onboarding, the app) may read about this harness. The harness itself is offered through Ferrets' `harnesses` hook. */
export interface CodexApi {
  /** Where `claude` is, how it was installed, whether Ferretry verified its version. Asks npm only when someone looks. */
  view(): Promise<HarnessCliView>;
  /** What discovery last found; `undefined` before the first look. Never reads the harness's sign-in files. */
  discovery(): Promise<Discovery | undefined>;
  /**
   * ADDITIVE. Which of a project's `.mcp.json` servers this harness takes for one ferret. Codex has no per-project
   * approval of `.mcp.json` servers: it reads a project's servers from `.codex/config.toml`, and today a Codex launch
   * is handed no project server's sign-in. So it always answers `not-taken`, never "all approved".
   */
  approvedProjectServers?(query: ProjectServerQuery): Promise<ProjectServerApprovals>;
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

/**
 * The ONE history pool every Codex ferret shares (docs/design/shared-history.md): a plain folder of this plugin's state,
 * never inside `agent-homes`. `sqlite` in it is Codex's state database folder, reached by `CODEX_SQLITE_HOME` (an env var,
 * not a link); the entries below are linked into each ferret home. `auth.json` and `config.toml` stay the ferret's own.
 */
export const CODEX_HISTORY_POOL = defineState({
  name: 'historyPool',
  path: 'history-pool/*',
  store: 'opaque',
  format: 1,
});

/** The entries of a Codex home that are history (v4's list), each linked to the same name in the pool. */
export const CODEX_HISTORY_ENTRIES = [
  { name: 'sessions', kind: 'folder' },
  { name: 'archived_sessions', kind: 'folder' },
  { name: 'history.jsonl', kind: 'file' },
] as const;

/** The folder of the pool that holds Codex's SQLite state (`CODEX_SQLITE_HOME`). */
export const CODEX_POOL_SQLITE = 'sqlite';

export const CODEX_DISCOVERY = defineState({
  name: 'discovery',
  path: 'discovery.json',
  store: 'json',
  format: 1,
  schema: DiscoverySchema,
});

export const CODEX_FAST_CATALOG = defineState({
  name: 'fastCatalog',
  path: 'fast-catalog.json',
  store: 'json',
  format: 1,
  schema: HeldCatalogSchema,
});

/** Per-ferret rollout provenance: baseline plus an explicitly resumed native conversation id. */
export const CodexRolloutBindingSchema = z.strictObject({
  format: z.literal(1),
  home: z.string(),
  baseline: z.array(z.string()),
  /** Whether the baseline saw every rollout already there (absent in a binding written before it was recorded). */
  baselineComplete: z.boolean().optional(),
  /** A pooled launch of a NEW conversation: the first day (`YYYY-MM-DD`) its rollout can be filed under; older days are never read. */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  native: z.string().optional(),
});
export type CodexRolloutBinding = z.infer<typeof CodexRolloutBindingSchema>;
export const CODEX_ROLLOUTS = defineState({
  name: 'rollouts',
  path: 'rollouts/*.json',
  store: 'json',
  format: 1,
  schema: CodexRolloutBindingSchema,
});

/** One section's fingerprint: a SHA-256 in hex, never the value it was taken of. */
const SectionDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * What one ferret was last launched under (W2-c, `Harness.launchSettings`): one fingerprint per section of this
 * plugin's own launch settings, written at every start and resume. Hashes only — no setting value, path or environment
 * value is kept — and in the daemon's state, never in the ferret's home, where its agent could rewrite it.
 */
export const CodexLaunchSettingsRecordSchema = z.strictObject({
  format: z.literal(1),
  sections: z.strictObject({
    'permission-mode': SectionDigestSchema,
    'fixed-layer': SectionDigestSchema,
    settings: SectionDigestSchema,
    /** Absent on a record written before hooks were fingerprinted: its hooks are unknown until the next start or resume. */
    hooks: SectionDigestSchema.optional(),
  }),
  /** The runtime this launch ran as (a name, not a secret): the selection of settings and hooks is read for it again. */
  runtime: z.string().min(1).max(128).optional(),
});
export type CodexLaunchSettingsRecord = z.infer<typeof CodexLaunchSettingsRecordSchema>;
export const CODEX_LAUNCH_SETTINGS = defineState({
  name: 'launchSettings',
  path: 'launch-settings/*.json',
  store: 'json',
  format: 1,
  schema: CodexLaunchSettingsRecordSchema,
  onDamaged: { narrower: 'a damaged launch record reads as unknown: nothing to say until the next launch' },
});

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `machineLoosening` rule for the permission mode. An unset mode means `skip` (owner decision !A525), so only an
 * EXPLICIT `auto` going to `skip` (or being removed, which reads as `skip`) is a loosening; no value to an explicit
 * `auto` is a tightening.
 */
export const harnessConfigLoosens: Loosens<HarnessConfig> = (before, after) =>
  before?.permissionMode === 'auto' && after.permissionMode === 'skip'
    ? ['agents now skip every permission prompt']
    : [];

/**
 * Any change to the harness `binary` or `searchPaths` (added, removed or changed, never judged by its value): the path
 * names the program every new ferret launches, so it is code execution and the owner's to approve (owner decision
 * !A525). Pure and total; the sentences name what changed, never a path.
 */
const harnessPathsChange: Loosens<HarnessConfig> = (before, after) => [
  ...(before?.binary === after.binary ? [] : ['agents now launch a different Codex program (binary changed)']),
  ...(JSON.stringify(before?.searchPaths ?? []) === JSON.stringify(after.searchPaths)
    ? []
    : ['agents now look for the Codex program in different directories (searchPaths changed)']),
];

/** What an agent's edit of this file is HELD for: a looser permission mode, or any change of where the program is. */
const harnessConfigHeld: Loosens<HarnessConfig> = (before, after) => [
  ...harnessConfigLoosens(before, after),
  ...harnessPathsChange(before, after),
];

/** `config/harness-codex.yaml`: the binary, the search directories and the permission mode. */
export const CODEX_CONFIG = configDef(
  defineConfig({
    file: 'harness-codex.yaml',
    schema: HarnessConfigSchema,
    axis: 'configure',
    loosens: harnessConfigHeld,
  }),
);

/**
 * A settings item loosens when an edit adds a launch flag that sets the approval policy or sandbox (`--sandbox`, `-a`,
 * `--full-auto`, `-c approval_policy=…`): the same loosening as a looser `permissionMode`, so an agent's edit waits for
 * the owner and the owner's own edit does not. The launch drops those flags anyway (`./launch-flags.ts`); the hold is so
 * none is ever written unseen.
 */
export const settingsItemLoosens: Loosens<SettingsItem> = (before, after) =>
  launchFlagsLoosen(before?.flags ?? [], after.flags ?? []);

/** `config/codex/settings/<name>.yaml`: a config document and its launch flags. */
export const CODEX_SETTINGS = configDef(
  defineConfig({
    collection: 'codex/settings',
    name: ITEM_NAME_PATTERN,
    schema: SettingsItemSchema,
    axis: 'configure',
    loosens: settingsItemLoosens,
  }),
);

/**
 * What an AGENT's write of `config/codex/hooks/<name>.yaml` is held for: EVERY add and EVERY change (owner ruling !A525
 * item 9). A hook is a shell command Codex runs on an event, so a new or edited one is code the owner must see; an
 * unchanged file holds nothing. Compared as written (a re-ordered key counts as a change: it fails closed). The sentence
 * never names a command. The owner's own write is never held.
 */
export const hooksItemHeld: Loosens<HooksItem> = (before, after) =>
  before === undefined
    ? ['agents now run a new Codex hooks component']
    : JSON.stringify(before) === JSON.stringify(after)
      ? []
      : ['agents now run changed Codex hooks'];

/** `config/codex/hooks/<name>.yaml`. Same shape as Claude Code's hooks items; Runtimes renders them as the runtime's `hooks.json`. An agent's add or change is HELD (`hooksItemHeld`). */
export const CODEX_HOOKS = configDef(
  defineConfig({
    collection: 'codex/hooks',
    name: ITEM_NAME_PATTERN,
    schema: HooksItemSchema,
    axis: 'configure',
    loosens: hooksItemHeld,
  }),
);
