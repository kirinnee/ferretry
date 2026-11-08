/**
 * @ferretry/plugin-claude-code/contract — wire schemas, port + token, events, state and config declarations, words.
 * Claude Code is a harness (§4.3): it takes `harnesses:claude-code` from Ferrets and offers nothing but a read port.
 */
import { InstantSchema } from '@ferretry/std';
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
  SettingsItemSchema,
} from './wire.ts';

export * from './wire.ts';

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

/** Today's `machineLoosening` rule for the permission mode, kept word for word. */
export const harnessConfigLoosens: Loosens<HarnessConfig> = (before, after) =>
  (before?.permissionMode ?? 'auto') === 'auto' && after.permissionMode === 'skip'
    ? ['agents now skip every permission prompt']
    : [];

/** `config/harness-claude-code.yaml`: the binary, the search directories and the permission mode. */
export const CLAUDE_CODE_CONFIG = configDef(
  defineConfig({
    file: 'harness-claude-code.yaml',
    schema: HarnessConfigSchema,
    axis: 'configure',
    loosens: harnessConfigLoosens,
  }),
);

const ITEM_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** `config/claude-code/settings/<name>.yaml`. Today a component edit changes what an agent runs with, never what it may spend. */
export const CLAUDE_CODE_SETTINGS = configDef(
  defineConfig({
    collection: 'claude-code/settings',
    name: ITEM_NAME,
    schema: SettingsItemSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

/** `config/claude-code/hooks/<name>.yaml`. */
export const CLAUDE_CODE_HOOKS = configDef(
  defineConfig({
    collection: 'claude-code/hooks',
    name: ITEM_NAME,
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
