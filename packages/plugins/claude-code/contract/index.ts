/**
 * @ferretry/plugin-claude-code/contract — wire schemas, port + token, events, state and config declarations, words.
 * Claude Code is a harness (§4.3): it takes `harnesses:claude-code` from Ferrets and offers nothing but a read port.
 */
import { InstantSchema, ITEM_NAME_PATTERN } from '@ferretry/std';
import {
  type FerretId,
  defineConfig,
  defineEvent,
  definePort,
  defineState,
  type Loosens,
  neverLoosens,
} from '@ferretry/kernel/contract';
import type { Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import {
  DiscoverySchema,
  HarnessConfigSchema,
  type Discovery,
  type HarnessCliView,
  type HarnessConfig,
  HooksItemSchema,
  type SettingsItem,
  SettingsItemSchema,
} from './wire.ts';
import { launchFlagsLoosen } from './launch-flags.ts';

export * from './wire.ts';
export { launchFlagsKept } from './launch-flags.ts';

/** The harness key and plugin id. */
export const CLAUDE_CODE = 'claude-code' as const;

/** Words (§1): the glossary entries this plugin owns. */
export const CLAUDE_CODE_WORDS: readonly Word[] = [
  { word: 'harness', means: 'the program a ferret runs in', insteadOf: ['agent CLI'] },
  { word: 'transcript', means: "the harness's own record of a conversation", insteadOf: ['jsonl', 'history'] },
];

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
export interface ClaudeCodeApi {
  /** Where `claude` is, how it was installed, whether Ferretry verified its version. Asks npm only when someone looks. */
  view(): Promise<HarnessCliView>;
  /** What discovery last found; `undefined` before the first look. Never reads the harness's sign-in files. */
  discovery(): Promise<Discovery | undefined>;
  /**
   * ADDITIVE. Which of a project's `.mcp.json` servers this harness approved, left pending or DISABLED for one
   * ferret in `root` — read by this plugin from the ferret's OWN home (its `.claude.json` `projects[<root>]` and its
   * `settings.json`), never handed to anyone as a document. A home it cannot read answers `unreadable`, so a caller
   * binds nothing it cannot tell was declined (fail closed). MCP asks it before handing a project server's sign-in
   * to a launch; MCP has no root over the home.
   */
  approvedProjectServers?(query: ProjectServerQuery): Promise<ProjectServerApprovals>;
}
export const ClaudeCodePort = definePort<ClaudeCodeApi>('claude-code');

/** Read models others may call (`manifest.data.readModels`). */
export const CLAUDE_CODE_READ_MODELS = ['view', 'discovery'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** An update of `claude` ended (after its write). */
export const ClaudeCodeUpdateFinished = defineEvent(
  'claude-code.update-finished',
  z.strictObject({ outcome: z.enum(['succeeded', 'unchanged', 'rolled-back', 'failed']), finishedAt: InstantSchema }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Claude Code's own per-ferret home format. Ferretry writes inside it and never reads its sign-in files. */
export const CLAUDE_CODE_AGENT_HOMES = defineState({
  name: 'agentHomes',
  path: 'agent-homes/*',
  store: 'opaque',
  format: 1,
});

/**
 * The ONE history pool every Claude ferret shares (docs/design/shared-history.md): a plain folder of this plugin's
 * state, never inside `agent-homes`, so it is never a credential home. Each ferret home links the entries below to it
 * (`RootHandle.linkHistory`); a sign-in, a setting and an instruction file stay the ferret's own.
 */
export const CLAUDE_CODE_HISTORY_POOL = defineState({
  name: 'historyPool',
  path: 'history-pool/*',
  store: 'opaque',
  format: 1,
});

/** The entries of a Claude home that are history (v4's list), each linked to the same name in the pool. */
export const CLAUDE_CODE_HISTORY_ENTRIES = [
  { name: 'projects', kind: 'folder' },
  { name: 'sessions', kind: 'folder' },
  { name: 'session-env', kind: 'folder' },
  { name: 'file-history', kind: 'folder' },
  { name: 'plans', kind: 'folder' },
  { name: 'tasks', kind: 'folder' },
  { name: 'todos', kind: 'folder' },
  { name: 'shell-snapshots', kind: 'folder' },
  { name: 'paste-cache', kind: 'folder' },
  { name: 'history.jsonl', kind: 'file' },
] as const;

export const CLAUDE_CODE_DISCOVERY = defineState({
  name: 'discovery',
  path: 'discovery.json',
  store: 'json',
  format: 1,
  schema: DiscoverySchema,
});

/** One section's fingerprint: a SHA-256 in hex, never the value it was taken of. */
const SectionDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * What one ferret was last launched under (W2-c, `Harness.launchSettings`): one fingerprint per section of this
 * plugin's own launch settings, written at every start and resume. Hashes only — no setting value, path or environment
 * value is kept — and in the daemon's state, never in the ferret's home, where its agent could rewrite it.
 */
export const LaunchSettingsRecordSchema = z.strictObject({
  format: z.literal(1),
  sections: z.strictObject({
    'permission-mode': SectionDigestSchema,
    'fixed-layer': SectionDigestSchema,
    settings: SectionDigestSchema,
    hooks: SectionDigestSchema,
  }),
  /** The runtime this launch ran as (a name, not a secret): the selection of settings and hooks is read for it again. */
  runtime: z.string().min(1).max(128).optional(),
});
export type LaunchSettingsRecord = z.infer<typeof LaunchSettingsRecordSchema>;
export const CLAUDE_CODE_LAUNCH_SETTINGS = defineState({
  name: 'launchSettings',
  path: 'launch-settings/*.json',
  store: 'json',
  format: 1,
  schema: LaunchSettingsRecordSchema,
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
  ...(before?.binary === after.binary ? [] : ['agents now launch a different Claude Code program (binary changed)']),
  ...(JSON.stringify(before?.searchPaths ?? []) === JSON.stringify(after.searchPaths)
    ? []
    : ['agents now look for the Claude Code program in different directories (searchPaths changed)']),
];

/** Turning the dangerous-rm waiver on (it defaults off, so no value to `true` is a loosening too). */
const rmWaiverLoosens: Loosens<HarnessConfig> = (before, after) =>
  before?.dangerousRmWaiver !== true && after.dangerousRmWaiver
    ? ['agents now run Claude Code with its dangerous-rm guard waived (bypass mode only)']
    : [];

/**
 * Turning the host history back ON (`hostHistory` false to true, or the key removed so it reads as the default true): the
 * harness file is agent-writable, and the host history is the owner's private conversations, so an agent's edit that
 * re-enables reading them waits for the owner. Switching it OFF is a tightening and is never held; a file that did not
 * exist reads as on, so creating it loosens nothing.
 */
const hostHistoryLoosens: Loosens<HarnessConfig> = (before, after) =>
  before?.hostHistory === false && after.hostHistory
    ? ["agents may now read the owner's own Claude conversations on this computer (hostHistory turned on)"]
    : [];

/** What an agent's edit of this file is HELD for: a looser permission mode or rm guard, host history turned on, or any change of where the program is. */
const harnessConfigHeld: Loosens<HarnessConfig> = (before, after) => [
  ...harnessConfigLoosens(before, after),
  ...rmWaiverLoosens(before, after),
  ...hostHistoryLoosens(before, after),
  ...harnessPathsChange(before, after),
];

/** `config/harness-claude-code.yaml`: the binary, the search directories and the permission mode. */
export const CLAUDE_CODE_CONFIG = configDef(
  defineConfig({
    file: 'harness-claude-code.yaml',
    schema: HarnessConfigSchema,
    axis: 'configure',
    loosens: harnessConfigHeld,
  }),
);

/**
 * A settings item loosens when an edit adds a launch flag that sets the permission mode (`--permission-mode`, the skip
 * switches): the same loosening as a looser `permissionMode`, so an agent's edit waits for the owner and the owner's own
 * edit does not. The launch drops those flags anyway (`./launch-flags.ts`); the hold is so none is ever written unseen.
 */
export const settingsItemLoosens: Loosens<SettingsItem> = (before, after) =>
  launchFlagsLoosen(before?.flags ?? [], after.flags ?? []);

/** `config/claude-code/settings/<name>.yaml`: a settings document and its launch flags. */
export const CLAUDE_CODE_SETTINGS = configDef(
  defineConfig({
    collection: 'claude-code/settings',
    name: ITEM_NAME_PATTERN,
    schema: SettingsItemSchema,
    axis: 'configure',
    loosens: settingsItemLoosens,
  }),
);

/** `config/claude-code/hooks/<name>.yaml`. */
export const CLAUDE_CODE_HOOKS = configDef(
  defineConfig({
    collection: 'claude-code/hooks',
    name: ITEM_NAME_PATTERN,
    schema: HooksItemSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

// ─── audit kinds this plugin records (Gate's log; names are today's events) ─────────────────────────────────────────

/** `terminal.input` with `mode: 'permission'` / `'dialog'`: keys into the proved pane, never the choice (G31, G32). */
export const CLAUDE_CODE_AUDIT = {
  permission: 'terminal.input:permission',
  dialog: 'terminal.input:dialog',
} as const;
