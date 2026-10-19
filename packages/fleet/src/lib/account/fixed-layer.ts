/**
 * The fixed layer — what Ferretry adds LAST to an agent runtime, and what it overrides
 * (docs/design/account-model.md §3.6, §8.4, F1–F5, E24).
 *
 * Only agent runtimes get it (F1). Its contents are exactly three things and never a credential or
 * an identity (F3): no trust prompt, no onboarding screens, and the permission mode from the
 * machine's **Agent permissions** (F4). Two carried-over launch flags join it because nobody is
 * there to answer an UNATTENDED agent: Claude's `--disallowed-tools=AskUserQuestion` (owner question O3,
 * now per ferret — an interactive ferret has the owner and keeps its question tool) and Codex's `--no-alt-screen`.
 *
 * It also puts the Ferretry tools in every agent runtime — the `fy mcp serve` MCP server, through which
 * an agent drives terminals and browser pages by name — and a short instruction saying they exist and
 * how names work (`--mcp-config` and `--append-system-prompt` for Claude; `mcp_servers.ferretry` and
 * `developer_instructions` for Codex). Like the rest, both are locked entries a surface shows.
 *
 * It wins because it is LAUNCH ARGUMENTS, which outrank every file the harness or the person can
 * edit (§8.4). So {@link applyFixedLayer} appends them after every flag the profile carries and
 * drops the profile's own flags that would fight them, and reports each user value it overrode so
 * a surface can strike it through (F2, E24).
 *
 * Measured, and authoritative over the design where they differ:
 *
 * - Every agent launch names its permission mode EXPLICITLY. Claude 2.1.296 made `auto` its default,
 *   so leaving the flag off would hand the choice to whichever version is installed.
 * - Codex's trust override is the TOML inline table `-c projects={"<cwd>"={trust_level="trusted"}}`.
 *   The design's dotted spelling makes the quotes part of the key and does not work. The table
 *   MERGES with `config.toml`'s own `projects`, so it names the launch folder alone.
 * - The bypass-permissions warning is suppressed by a `--settings` overlay holding
 *   `skipDangerousModePermissionPrompt`, returned here as `claudeSettingsOverlay` for the wrapper
 *   (`./materialise.ts`) to write and pass, because where that file lives is the wrapper's fact.
 * - The overlay ALSO names the permission mode. Claude 2.1.281 shows a one-shot "Make auto mode your
 *   default permission mode?" dialog to any config dir whose USER `settings.json` names a non-auto
 *   `permissions.defaultMode` while no project, local, FLAG or policy source names one — which is
 *   exactly what the settings entry below writes. The `--permission-mode` argument is not a settings
 *   source, so it did not count, and an agent nobody watches sat on the dialog with every message
 *   failing. A `--settings` file IS the flag source, so naming the same mode there removes the
 *   condition; {@link CLAUDE_PROMPTS_SEEN} records the dialog as seen as well, and either alone holds.
 * - Codex's one-shot notices (the full-access warning, the rate-limit model nudge, the model
 *   migration prompts) are hidden with ONE `-c notice={…}` inline table, which merges with
 *   `config.toml`'s own `[notice]` like the trust table does.
 *
 * Owner question O4, built with the lead's default: when the installed Claude does not accept
 * `--permission-mode auto`, the agent runtime is REFUSED with the fix named. Auto mode is never
 * mapped to a weaker or a stronger mode behind anybody's back.
 *
 * Pure and total: the machine setting, the launch folder and what the installed Claude accepts are
 * all parameters, read at launch by the caller, so a change applies to new sessions only (F5).
 */
import type { HarnessKind } from '../manifest.ts';
import { deepMergeSettings, type SettingsObject } from '../settings.ts';
import {
  type FlagContribution,
  type FlatLayer,
  pathsOverlap,
  type ResolvedProfile,
  sameSettingsValue,
  settingsKey,
} from './layering.ts';
import type { AgentPermissions } from './schema.ts';

/** What one fixed-layer entry is for, as the read-only lock shows it. */
export type FixedEntryPurpose =
  | 'permission-mode'
  | 'skip-prompt'
  | 'trust'
  | 'onboarding'
  | 'one-time-prompts'
  | 'no-questions'
  | 'no-alt-screen'
  | 'tools'
  | 'instructions';

/**
 * One locked entry of the fixed layer (F2).
 *
 * `target` is the document the value is about: the harness's `settings` (Claude `settings.json`,
 * Codex `config.toml`) — the ones a Settings component can also set, and so the ones an override is
 * reported against — Claude's per-config-directory `claude-json`, or a bare `launch` flag.
 */
export interface FixedEntry {
  readonly purpose: FixedEntryPurpose;
  readonly target: 'settings' | 'claude-json' | 'launch';
  readonly path: readonly string[];
  readonly key: string;
  readonly value: unknown;
}

export interface FixedLayer {
  readonly harness: HarnessKind;
  readonly agentPermissions: AgentPermissions;
  readonly entries: readonly FixedEntry[];
  /** Launch arguments, appended after every flag the profile carries. */
  readonly args: readonly string[];
  /**
   * Claude only: the body of the `--settings` overlay, when the layer needs one. The wrapper writes
   * it and passes `--settings <file>` after {@link FixedLayer.args}.
   */
  readonly claudeSettingsOverlay?: SettingsObject;
  /** Claude only: the keys re-asserted into the config directory's `.claude.json` before launch. */
  readonly claudeJson?: SettingsObject;
}

/** Why an agent runtime cannot be launched as asked. */
export interface FixedLayerRefusal {
  readonly kind: 'claude-auto-mode-unsupported';
  readonly message: string;
}

export type FixedLayerResult =
  | { readonly ok: true; readonly layer: FixedLayer }
  | { readonly ok: false; readonly refusal: FixedLayerRefusal };

export type FixedLayerInput =
  | {
      readonly harness: 'claude';
      readonly agentPermissions: AgentPermissions;
      /** The folder the agent is launched in. */
      readonly cwd: string;
      /** Whether the installed Claude accepts `--permission-mode auto` (O4). */
      readonly acceptsAutoPermissionMode: boolean;
      /** The `fy` executable the tools server runs as. */
      readonly fyCommand: string;
    }
  | {
      readonly harness: 'codex';
      readonly agentPermissions: AgentPermissions;
      readonly cwd: string;
      readonly fyCommand: string;
    };

/** Claude's spelling of each Agent permissions choice (§3.6). */
export const CLAUDE_PERMISSION_MODES: Readonly<Record<AgentPermissions, string>> = {
  auto: 'auto',
  skip: 'bypassPermissions',
};

/**
 * The one-time screens Claude records as SEEN in a config directory's `.claude.json`, each a dialog
 * that parks a launch until somebody answers it. Read off Claude 2.1.281's bundle, where each is the
 * gate of its dialog:
 *
 * - `hasSeenAutoDefaultNudge` — "Make auto mode your default permission mode?" (`shouldShowAutoDefaultNudge`).
 * - `hasSeenEffortMediumNudge` and `hasSeenEffortMediumNudgeByModel` — "Switch your default effort to
 *   …?", per model, for the two models it is served for.
 * - `fullscreenUpsellSeenCount` — "Try the new fullscreen renderer?", shown until it reaches 3.
 *
 * Each says only "already seen": none of them changes a mode, an effort or a renderer, so answering
 * them for an agent decides nothing on the owner's behalf. The wrapper re-asserts them before every
 * launch (`../wrappers.ts`); a value already past what is written here is kept.
 */
export const CLAUDE_PROMPTS_SEEN = {
  hasSeenAutoDefaultNudge: true,
  hasSeenEffortMediumNudge: true,
  hasSeenEffortMediumNudgeByModel: { 'claude-opus-5': true, 'claude-fable-5-1': true },
  fullscreenUpsellSeenCount: 3,
} as const;

/**
 * Codex's `[notice]` keys that hide a one-shot prompt, read off codex-cli 0.156.1's `Notice` table.
 * Every one is a boolean "hide it"; `fast_default_opt_out` and `model_migrations` are choices rather
 * than hides, so they are left alone.
 */
export const CODEX_HIDDEN_NOTICES: readonly string[] = [
  'hide_full_access_warning',
  'hide_world_writable_warning',
  'hide_rate_limit_model_nudge',
  'hide_gpt5_1_migration_prompt',
  'hide_gpt-5.1-codex-max_migration_prompt',
];

/** The `-c notice={…}` inline table hiding every {@link CODEX_HIDDEN_NOTICES}. */
export const codexNoticeOverride = (): string =>
  `notice={${CODEX_HIDDEN_NOTICES.map(key => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)}=true`).join(',')}}`;

/** Codex's spelling of each Agent permissions choice (§3.6). */
export const CODEX_PERMISSIONS: Readonly<
  Record<AgentPermissions, { readonly approvalPolicy: string; readonly sandboxMode: string }>
> = {
  auto: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  skip: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
};

/**
 * O3: an unattended (`auto`) ferret has nobody to answer a question, so the tool that asks one is
 * withheld. An INTERACTIVE ferret has the owner, so it keeps it — which makes this per FERRET, not per
 * runtime: the wrapper (`../wrappers.ts`) applies the flag at exec time unless the daemon-written
 * {@link SESSION_MODE_ENV} is `interactive`. A launch with no mode is treated as unattended.
 */
export const CLAUDE_NO_QUESTIONS_FLAG = '--disallowed-tools=AskUserQuestion';

/** Codex gates `request_user_input` outside Plan mode behind this feature; only interactive ferrets enable it. */
export const CODEX_QUESTIONS_FEATURE = 'default_mode_request_user_input';

/** The launch variable naming a ferret's mode (`interactive` or `auto`); written by the daemon at creation. */
export const SESSION_MODE_ENV = 'FY_SESSION_MODE';

export const CODEX_NO_ALT_SCREEN_FLAG = '--no-alt-screen';

const CARRIED_FLAGS: ReadonlySet<string> = new Set([CLAUDE_NO_QUESTIONS_FLAG, CODEX_NO_ALT_SCREEN_FLAG]);

/** The name the Ferretry tools server is registered under, in both harnesses. */
export const FERRETRY_MCP_SERVER = 'ferretry';

/** How the harness starts the tools server: the `fy` the wrapper already uses, as `fy mcp serve`. */
export const FERRETRY_MCP_ARGS: readonly string[] = ['mcp', 'serve'];

/**
 * The variables the tools server needs from the agent's environment: where the daemon is, and the
 * agent session's own credential — the one thing that tells the daemon which session is calling, and
 * the whole of the server's authority. NOT `FY_TOKEN`: the host's admin token is no part of it. Codex
 * hands a stdio server only a short default list, so these are named for it; Claude hands it the whole
 * environment, so its entry blanks `FY_TOKEN` instead.
 */
export const FERRETRY_MCP_ENV_VARS: readonly string[] = [
  'FY_HOME',
  'FY_URL',
  'FY_SESSION_ID',
  'FY_SESSION_BOARD_CAPABILITY',
  'FY_LEARNING_PASSIVE',
  'FY_HYPERMEDIA',
];

/**
 * PASSIVE LEARNING — a fixed-layer entry that differs per FERRET rather than per runtime (as {@link HYPERMEDIA_ENV} does).
 *
 * A runtime's wrapper is materialised once and serves every ferret launched on it, so the teaching
 * cannot be a launch argument: it would be on for all of them or none. It rides the tools server the
 * fixed layer already puts in every agent runtime instead. The daemon sets {@link PASSIVE_LEARNING_ENV}
 * to `1` in the environment of a ferret that is instructed to learn, and `fy mcp serve` adds
 * {@link LESSONS_INSTRUCTION} to its MCP `initialize` instructions iff it is set (Codex is handed the
 * variable through {@link FERRETRY_MCP_ENV_VARS}; Claude hands a stdio server its whole environment).
 *
 * That is ALL the switch does: whether this ferret is told to file lessons. A running ferret switched
 * on or off is told so with a queued, non-interrupting message, because its environment is fixed.
 */
export const PASSIVE_LEARNING_ENV = 'FY_LEARNING_PASSIVE';

/** The teaching a ferret that is instructed to learn carries. Short on purpose — it is in every prompt. */
export const LESSONS_INSTRUCTION = (fy: string): string =>
  `Lessons: when the owner corrects you, or you learn a durable fact about how they want work done, file it as one short imperative rule with \`${fy} lesson suggest "<rule>" --scope global|repo\` (or the lessons_suggest tool). Use --scope repo for a fact about this project and --scope global for one every ferret should follow. File each lesson once; the owner reviews every lesson before it reaches an instruction file.`;

/**
 * HYPERMEDIA — the second per-FERRET fixed-layer entry, carried exactly like passive learning and for
 * the same reason: one runtime wrapper serves many ferrets, so a launch argument would be on for all of
 * them or none. The daemon sets {@link HYPERMEDIA_ENV} to `1` (or `0`) in a ferret's launch environment
 * and `fy mcp serve` adds {@link HYPERMEDIA_INSTRUCTION} to its MCP `initialize` instructions iff it is
 * `1`. A ferret switched while running learns it at its next launch; nothing is sent to it.
 *
 * The markup it teaches is the `fy-render` fence (docs/fy-render.md), and docs/hypermedia.md is the
 * contract that quotes this text verbatim.
 */
export const HYPERMEDIA_ENV = 'FY_HYPERMEDIA';

/** The hypermedia teaching. Short on purpose — it is in every prompt. docs/hypermedia.md quotes it. */
export const HYPERMEDIA_INSTRUCTION = [
  'Hypermedia: when an idea is not straightforward — a flow, an architecture, a state machine, a comparison, a layout, a change over time — show it in your chat reply as well as saying it. Do not overdo it: a simple answer stays plain text, and one clear picture beats several. Write a fenced block whose info string is exactly fy-render: line 1 `type: <type>`, line 2 `alt: <one-line description>`, then a line `---`, then the payload.',
  '- mermaid: Mermaid source (flowchart, sequenceDiagram, stateDiagram-v2, …).',
  '- svg: one self-contained <svg>…</svg>; no script, foreignObject, use or external links.',
  '- html: one self-contained interactive page with inline CSS and JS; it runs sandboxed, so load nothing from the network.',
  '- image, video, audio, pdf: put `src: @path/in/your/workspace` or `src: https://…` before `---`, and no payload.',
  'Example:',
  '```fy-render',
  'type: mermaid',
  'alt: How a request reaches the daemon',
  '---',
  'flowchart LR',
  '  Phone --> Relay --> Daemon',
  '```',
  'The reader taps Render to show it. Chat only: never write fy-render into files, docs, commits or PR text.',
].join('\n');

/** The built-in instruction: the tools exist, and how names work. Short on purpose — it is in every prompt. */
export const AGENT_TOOLS_INSTRUCTION =
  'Ferretry tools: you can open and drive terminals and browser pages the person watches live, with the ferretry MCP tools (terminal_open, terminal_send, terminal_read, terminal_wait, terminal_close, terminal_list, browser_open, browser_navigate, browser_click, browser_type, browser_read, browser_screenshot, browser_close, browser_list). Give each one a short lowercase name such as dev or app; you and the person both refer to it as %terminal:dev or %browser:app, and you can pass such a reference as the name. Use them when the person should see the work. If a tool says a person has taken a tab over, wait or ask them.';

/** Claude's `--mcp-config` document for the tools server: a JSON string, so no file has to exist. */
export const claudeToolsConfig = (fyCommand: string): SettingsObject => ({
  mcpServers: {
    [FERRETRY_MCP_SERVER]: {
      type: 'stdio',
      command: fyCommand,
      args: [...FERRETRY_MCP_ARGS],
      // Claude passes a stdio server the agent's whole environment; the admin token must not be in it.
      env: { FY_TOKEN: '' },
    },
  },
});

/** Codex's `mcp_servers.ferretry` table for the tools server. */
export const codexToolsServer = (fyCommand: string): SettingsObject => ({
  command: fyCommand,
  args: [...FERRETRY_MCP_ARGS],
  env_vars: [...FERRETRY_MCP_ENV_VARS],
});

/** A TOML array of basic strings, for a `-c` override. */
const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(',')}]`;

/** A TOML basic string: what a `-c` override needs to carry any folder path. */
export function tomlString(value: string): string {
  const escaped = [...value]
    .map(character => {
      if (character === '\\') return '\\\\';
      if (character === '"') return '\\"';
      const code = character.codePointAt(0) as number;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
  return `"${escaped}"`;
}

/** The measured Codex trust override for one folder: a TOML inline table, never a dotted key. */
export const codexTrustOverride = (cwd: string): string => `projects={${tomlString(cwd)}={trust_level="trusted"}}`;

const entry = (
  purpose: FixedEntryPurpose,
  target: FixedEntry['target'],
  path: readonly string[],
  value: unknown,
): FixedEntry => ({ purpose, target, path, key: target === 'launch' ? path.join(' ') : settingsKey(path), value });

const AUTO_MODE_REFUSAL =
  "Claude Code on this machine does not accept Auto mode (--permission-mode auto), so Ferretry won't launch this agent runtime. Update Claude Code, or switch this machine's Agent permissions to Skip all permission checks.";

/** The fixed layer for an agent runtime of `input.harness`, or the reason it cannot launch (O4). */
export function fixedLayerFor(input: FixedLayerInput): FixedLayerResult {
  const { agentPermissions, cwd, fyCommand } = input;
  if (input.harness === 'claude') {
    if (agentPermissions === 'auto' && !input.acceptsAutoPermissionMode) {
      return { ok: false, refusal: { kind: 'claude-auto-mode-unsupported', message: AUTO_MODE_REFUSAL } };
    }
    const mode = CLAUDE_PERMISSION_MODES[agentPermissions];
    const skip = agentPermissions === 'skip';
    const entries = [
      entry('permission-mode', 'settings', ['permissions', 'defaultMode'], mode),
      ...(skip ? [entry('skip-prompt', 'settings', ['skipDangerousModePermissionPrompt'], true)] : []),
      entry('trust', 'claude-json', ['projects', cwd, 'hasTrustDialogAccepted'], true),
      entry('onboarding', 'claude-json', ['hasCompletedOnboarding'], true),
      ...Object.entries(CLAUDE_PROMPTS_SEEN).map(([key, value]) =>
        entry('one-time-prompts', 'claude-json', [key], value),
      ),
      ...(skip ? [] : [entry('skip-prompt', 'settings', ['skipAutoPermissionPrompt'], true)]),
      entry('no-questions', 'launch', [CLAUDE_NO_QUESTIONS_FLAG], true),
      entry('tools', 'launch', ['--mcp-config'], claudeToolsConfig(fyCommand)),
      entry('instructions', 'launch', ['--append-system-prompt'], AGENT_TOOLS_INSTRUCTION),
    ];
    return {
      ok: true,
      layer: {
        harness: 'claude',
        agentPermissions,
        entries,
        // Both in their `=` spelling: `--mcp-config` takes several values, and a bare one would swallow
        // the arguments after it — the prompt included.
        args: [
          '--permission-mode',
          mode,
          CLAUDE_NO_QUESTIONS_FLAG,
          `--mcp-config=${JSON.stringify(claudeToolsConfig(fyCommand))}`,
          `--append-system-prompt=${AGENT_TOOLS_INSTRUCTION}`,
        ],
        // The mode is named HERE too: the overlay is the flag settings source, and a mode named by one
        // is what keeps the auto-default dialog away (see the header).
        claudeSettingsOverlay: {
          permissions: { defaultMode: mode },
          ...(skip ? { skipDangerousModePermissionPrompt: true } : { skipAutoPermissionPrompt: true }),
        },
        claudeJson: {
          hasCompletedOnboarding: true,
          ...CLAUDE_PROMPTS_SEEN,
          projects: { [cwd]: { hasTrustDialogAccepted: true } },
        },
      },
    };
  }
  const { approvalPolicy, sandboxMode } = CODEX_PERMISSIONS[agentPermissions];
  return {
    ok: true,
    layer: {
      harness: 'codex',
      agentPermissions,
      entries: [
        entry('permission-mode', 'settings', ['approval_policy'], approvalPolicy),
        entry('permission-mode', 'settings', ['sandbox_mode'], sandboxMode),
        entry('trust', 'settings', ['projects', cwd, 'trust_level'], 'trusted'),
        entry('no-alt-screen', 'launch', [CODEX_NO_ALT_SCREEN_FLAG], true),
        ...CODEX_HIDDEN_NOTICES.map(key => entry('one-time-prompts', 'settings', ['notice', key], true)),
        entry('tools', 'settings', ['mcp_servers', FERRETRY_MCP_SERVER], codexToolsServer(fyCommand)),
        entry('instructions', 'settings', ['developer_instructions'], AGENT_TOOLS_INSTRUCTION),
      ],
      args: [
        '-c',
        `approval_policy=${tomlString(approvalPolicy)}`,
        '-c',
        `sandbox_mode=${tomlString(sandboxMode)}`,
        '-c',
        codexTrustOverride(cwd),
        CODEX_NO_ALT_SCREEN_FLAG,
        '-c',
        codexNoticeOverride(),
        '-c',
        `mcp_servers.${FERRETRY_MCP_SERVER}.command=${tomlString(fyCommand)}`,
        '-c',
        `mcp_servers.${FERRETRY_MCP_SERVER}.args=${tomlArray(FERRETRY_MCP_ARGS)}`,
        '-c',
        `mcp_servers.${FERRETRY_MCP_SERVER}.env_vars=${tomlArray(FERRETRY_MCP_ENV_VARS)}`,
        '-c',
        `developer_instructions=${tomlString(AGENT_TOOLS_INSTRUCTION)}`,
      ],
    },
  };
}

// ── Applying it ──────────────────────────────────────────────────────────────────────────────────

/** A user value the fixed layer overrides, shown struck through (E24). */
export type FixedOverride =
  | {
      readonly kind: 'setting';
      readonly key: string;
      readonly path: readonly string[];
      readonly value: unknown;
      readonly layer: FlatLayer;
      readonly fixed: FixedEntry;
    }
  | {
      /** A profile flag dropped from the launch because the fixed layer decides what it decides. */
      readonly kind: 'flag';
      /** The flag as written, with its value when it takes one: `['--permission-mode', 'plan']`. */
      readonly tokens: readonly string[];
      readonly layer: FlatLayer;
    };

/** An agent runtime's launch, with the fixed layer applied last. */
export interface AgentLaunch {
  readonly fixed: FixedLayer;
  /** The profile's settings with every fixed `settings` entry written over them. */
  readonly settings: SettingsObject;
  /** The profile's surviving flags in order, then the fixed layer's arguments. */
  readonly args: readonly string[];
  readonly overridden: readonly FixedOverride[];
}

/**
 * The permission flags each harness's fixed layer replaces. `value` flags take the next token as
 * their value unless written `--flag=value`; `config` is Codex's `-c key=value`, superseded only for
 * the keys the fixed layer sets.
 */
const SUPERSEDED_FLAGS: Readonly<Record<HarnessKind, Readonly<Record<string, 'bare' | 'value' | 'config'>>>> = {
  claude: {
    '--permission-mode': 'value',
    '--dangerously-skip-permissions': 'bare',
    '--allow-dangerously-skip-permissions': 'bare',
    // The person's own instruction is APPENDED to, not replaced: see `appendedInstructions`.
    '--append-system-prompt': 'value',
  },
  codex: {
    '--dangerously-bypass-approvals-and-sandbox': 'bare',
    '--full-auto': 'bare',
    '--ask-for-approval': 'value',
    '-a': 'value',
    '--sandbox': 'value',
    '-s': 'value',
    '--config': 'config',
    '-c': 'config',
  },
};

const CODEX_FIXED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'approval_policy',
  'sandbox_mode',
  'developer_instructions',
]);

/** A Codex `-c` key the fixed layer decides: its own, or anything under the tools server's table. */
const isFixedCodexKey = (key: string): boolean =>
  CODEX_FIXED_CONFIG_KEYS.has(key) ||
  key === `mcp_servers.${FERRETRY_MCP_SERVER}` ||
  key.startsWith(`mcp_servers.${FERRETRY_MCP_SERVER}.`);

/** Split a profile's flags into the ones the launch keeps and the ones the fixed layer replaces. */
function partitionFlags(
  harness: HarnessKind,
  flags: readonly FlagContribution[],
  fixedArgs: readonly string[],
): { readonly kept: readonly string[]; readonly dropped: readonly FixedOverride[] } {
  const table = SUPERSEDED_FLAGS[harness];
  const fixedTokens = new Set(fixedArgs.filter(arg => CARRIED_FLAGS.has(arg)));
  const kept: string[] = [];
  const dropped: FixedOverride[] = [];
  for (let index = 0; index < flags.length; index++) {
    const { flag, layer } = flags[index] as FlagContribution;
    const equals = flag.indexOf('=');
    const name = equals > 0 ? flag.slice(0, equals) : flag;
    const shape = table[name];
    if (shape === undefined) {
      // A flag the fixed layer passes itself would be passed twice, which a strict parser refuses.
      if (!fixedTokens.has(flag)) kept.push(flag);
      continue;
    }
    const inline = equals > 0;
    const next = flags[index + 1];
    const takesNext = shape !== 'bare' && !inline && next !== undefined;
    const tokens = takesNext ? [flag, (next as FlagContribution).flag] : [flag];
    if (shape === 'config') {
      const assignment = inline ? flag.slice(equals + 1) : (next?.flag ?? '');
      const key = assignment.split('=')[0]?.trim() ?? '';
      if (!isFixedCodexKey(key)) {
        kept.push(...tokens);
        if (takesNext) index++;
        continue;
      }
    }
    dropped.push({ kind: 'flag', tokens, layer });
    if (takesNext) index++;
  }
  return { kept, dropped };
}

/** The fixed `settings` entries as one document, to write over the profile's own. */
const fixedSettingsDocument = (entries: readonly FixedEntry[]): SettingsObject =>
  entries
    .filter(fixed => fixed.target === 'settings')
    .reduce<SettingsObject>((document, fixed) => {
      const nested = [...fixed.path].reverse().reduce<unknown>((inner, segment) => ({ [segment]: inner }), fixed.value);
      return deepMergeSettings(document, nested as SettingsObject);
    }, {});

/**
 * Apply `fixed` LAST to a profile resolved for the same harness (F1): its settings entries are
 * written over the profile's, its arguments come after the profile's flags, and every user value
 * that lost is reported (E24). A value the user set to exactly what the fixed layer sets is not an
 * override and is not reported.
 */
export function applyFixedLayer(resolved: ResolvedProfile, given: FixedLayer): AgentLaunch {
  const { fixed, absorbed } = appendedInstructions(resolved, given);
  const overridden: FixedOverride[] = [];
  for (const fixedEntry of fixed.entries) {
    if (fixedEntry.target !== 'settings') continue;
    for (const leaf of resolved.settings.leaves) {
      if (!pathsOverlap(leaf.path, fixedEntry.path)) continue;
      if (leaf.path.length === fixedEntry.path.length && sameSettingsValue(leaf.value, fixedEntry.value)) continue;
      overridden.push({
        kind: 'setting',
        key: leaf.key,
        path: leaf.path,
        value: leaf.value,
        layer: leaf.layer,
        fixed: fixedEntry,
      });
    }
  }
  const flags = partitionFlags(fixed.harness, resolved.flags, fixed.args);
  return {
    fixed,
    settings: deepMergeSettings(resolved.settings.value, fixedSettingsDocument(fixed.entries)),
    args: [...flags.kept, ...fixed.args],
    overridden: [...overridden, ...flags.dropped].filter(entry => !absorbed(entry)),
  };
}

/**
 * The person's own instruction, KEPT: Ferretry's tools instruction is appended after it rather than
 * replacing it. Claude takes one `--append-system-prompt` and Codex one `developer_instructions`, so
 * the two texts become one value, the person's first; and the person's value, now carried inside
 * Ferretry's, is not reported as overridden.
 */
function appendedInstructions(
  resolved: ResolvedProfile,
  fixed: FixedLayer,
): { readonly fixed: FixedLayer; readonly absorbed: (entry: FixedOverride) => boolean } {
  const own = fixed.entries.find(entry => entry.purpose === 'instructions');
  if (own === undefined) return { fixed, absorbed: () => false };
  const theirs: string[] = [];
  const flagOf = (flag: string): string => flag.split('=')[0] as string;
  if (fixed.harness === 'claude') {
    resolved.flags.forEach((contribution, index) => {
      const { flag } = contribution;
      if (flag.startsWith('--append-system-prompt=')) theirs.push(flag.slice('--append-system-prompt='.length));
      else if (flag === '--append-system-prompt' && resolved.flags[index + 1] !== undefined)
        theirs.push((resolved.flags[index + 1] as FlagContribution).flag);
    });
  } else {
    for (const leaf of resolved.settings.leaves)
      if (leaf.path.length === 1 && leaf.path[0] === 'developer_instructions' && typeof leaf.value === 'string')
        theirs.push(leaf.value);
    resolved.flags.forEach((contribution, index) => {
      const { flag } = contribution;
      const assignment = flag.startsWith('--config=')
        ? flag.slice('--config='.length)
        : (flag === '-c' || flag === '--config') && resolved.flags[index + 1] !== undefined
          ? (resolved.flags[index + 1] as FlagContribution).flag
          : '';
      if (assignment.trim().startsWith('developer_instructions='))
        theirs.push(unquoted(assignment.slice(assignment.indexOf('=') + 1)));
    });
  }
  if (theirs.length === 0) return { fixed, absorbed: () => false };
  const combined = [...theirs, own.value as string].join('\n\n');
  const args = fixed.args.map(arg =>
    arg.startsWith('--append-system-prompt=')
      ? `--append-system-prompt=${combined}`
      : arg.startsWith('developer_instructions=')
        ? `developer_instructions=${tomlString(combined)}`
        : arg,
  );
  const entries = fixed.entries.map(entry => (entry === own ? { ...entry, value: combined } : entry));
  return {
    fixed: { ...fixed, args, entries },
    absorbed: entry =>
      entry.kind === 'flag'
        ? flagOf(entry.tokens[0] as string) === '--append-system-prompt' ||
          entry.tokens.some(token =>
            token
              .replace(/^--config=/u, '')
              .trim()
              .startsWith('developer_instructions='),
          )
        : entry.fixed.purpose === 'instructions',
  };
}

/** A `-c` value as written: a TOML basic string loses its quotes; anything else is kept as it is. */
function unquoted(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}
