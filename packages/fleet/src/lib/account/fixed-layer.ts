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
 *   MERGES with `config.toml`'s own `projects`, so it names the launch folder alone — which also
 *   keeps a launch in a subdirectory of a Git repository from the prompt whose yes trusts the whole
 *   repository. From 0.160 Codex no longer asks about a folder with NO project marker and instead
 *   starts it on workspace-write with granular approvals; the explicit `approval_policy` and
 *   `sandbox_mode` below (and the trust entry, either alone) keep that default off, so an agent starts
 *   in the mode the machine chose on 0.145 and 0.163 alike (`tests/contract/codex-launch.test.ts`).
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
 * - Remote Control is forced OFF at startup (`remoteControlAtStartup: false`, also in the overlay).
 *   Claude Code 2.1.281 starts the bridge in a session when ANY of these is true, in this order:
 *   the `--rc` flag; an explicit `remoteControlAtStartup` from policy, FLAG, then user settings (and
 *   the legacy copy in `~/.claude.json`); and — only when none of those says — the account's org policy
 *   or GrowthBook default (`tengu_cobalt_harbor`). So a value copied in from the owner's own setup, or an
 *   account-side rollout, would start every unattended ferret with a web control channel nobody asked
 *   for. The overlay is the flag source, which outranks user settings and the account default; `--rc`
 *   still turns it on for the one ferret that asks (`remoteControlArgs`), and only an org policy lock
 *   can outrank us. Codex has nothing to switch: its `remote_control` feature is removed (0.156.1) and
 *   its remote control is a separate `codex remote-control` daemon, not a session startup behaviour.
 * - The overlay carries one `PreToolUse` hook for `AskUserQuestion` ({@link CLAUDE_QUESTION_HOOKS}).
 *   Claude Code 2.1.281 writes an `AskUserQuestion` call to its transcript only once the form is answered,
 *   so the daemon, which reads the transcript, never saw an open question; the hook hands it the call as
 *   it is asked. Fast mode's replacement overlay copies the whole file, hooks included.
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
import type { LaunchInstructionSectionId, SessionLaunchInstructions } from '@ferretry/protocol';
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
  | 'remote-control'
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

/** Claude's "start Remote Control in every session" preference. */
export const CLAUDE_REMOTE_CONTROL_KEY = 'remoteControlAtStartup';

/**
 * The launch variable naming the file a ferret's question hook writes, set by the daemon per session
 * (its own state folder). Unset — a person's own terminal, an older daemon — the hook writes nothing.
 */
export const QUESTION_ASKED_FILE_ENV = 'FY_QUESTION_FILE';

/**
 * The hook that tells the daemon a question is open. Claude Code 2.1.281 keeps an `AskUserQuestion` call
 * out of its transcript until the form is answered, so the daemon — which reads the transcript — saw no
 * question at all and offered only the Console. `PreToolUse` fires before the form is drawn, with the real
 * `tool_use_id` and the whole input on stdin: copied whole into {@link QUESTION_ASKED_FILE_ENV} (a rename,
 * so a reader never sees half a file). Its exit is always 0 and it prints nothing, even when the file
 * cannot be written, so it never changes what Claude decides; stdin is drained on every path, so Claude
 * never writes into a closed pipe.
 */
export const CLAUDE_QUESTION_HOOK_COMMAND = `if [ -n "$${QUESTION_ASKED_FILE_ENV}" ] && cat 2>/dev/null > "$${QUESTION_ASKED_FILE_ENV}.tmp" && mv -f "$${QUESTION_ASKED_FILE_ENV}.tmp" "$${QUESTION_ASKED_FILE_ENV}" 2>/dev/null; then :; else cat > /dev/null 2>&1; fi; exit 0`;

/**
 * The overlay's `hooks` block. In the OVERLAY only, never a `settings` entry: an entry is written over the
 * profile's settings, and would replace whatever `PreToolUse` hooks a person keeps there. Claude merges the
 * hooks of every settings source, so the overlay adds one beside theirs.
 */
export const CLAUDE_QUESTION_HOOKS: SettingsObject = {
  PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CLAUDE_QUESTION_HOOK_COMMAND }] }],
};

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
];

/**
 * THE PER-FERRET SECTIONS of the appended system prompt: passive learning ({@link PASSIVE_LEARNING_ENV}),
 * hypermedia ({@link HYPERMEDIA_ENV}) and Pack mode ({@link PACK_ENV}).
 *
 * A runtime's wrapper is materialised once and serves every ferret launched on it, so a section cannot
 * be a static launch argument: it would be on for all of them or none. The daemon writes each switch
 * into a ferret's launch environment as `1` or `0`, and the wrapper composes the ONE
 * `--append-system-prompt` (Claude) or `developer_instructions` (Codex) value at exec time — the
 * owner's own instruction, then {@link AGENT_INSTRUCTION}, then each section that is `1`, in
 * {@link FERRET_SECTIONS} order (`../wrappers.ts`). A restart or resume runs the same wrapper with the
 * same stored environment, so it keeps them — and turns off Claude's system-prompt record, which would
 * otherwise replay the conversation's FIRST launch's sections on every resume.
 *
 * They are system instructions rather than the tools server's MCP `initialize` text because a
 * harness weighs the system prompt far above a server's instructions, which an agent can ignore.
 *
 * Passive learning: whether this ferret is told to file lessons. A running ferret switched on or off
 * is told so with a queued, non-interrupting message, because its environment is fixed.
 */
export const PASSIVE_LEARNING_ENV = 'FY_LEARNING_PASSIVE';

/** The teaching a ferret that is instructed to learn carries. Short on purpose — it is in every prompt. */
export const LESSONS_INSTRUCTION = (fy: string): string =>
  `Lessons: when the owner corrects you or you learn a lasting preference of theirs, file one imperative rule: \`${fy} lesson suggest "<rule>" --scope global|repo\` (or lessons_suggest); global = every ferret, repo = this project. File each once; the owner reviews them.`;

/**
 * HYPERMEDIA — a per-FERRET section of the appended system prompt, carried exactly like passive learning
 * (see {@link PASSIVE_LEARNING_ENV}). A ferret switched while running learns it at its next launch;
 * nothing is sent to it.
 *
 * The markup it teaches is the `fy-render` fence (docs/fy-render.md), and docs/hypermedia.md is the
 * contract that quotes this text verbatim.
 */
export const HYPERMEDIA_ENV = 'FY_HYPERMEDIA';

/**
 * The hypermedia teaching. Short on purpose — it is in every prompt, so only mermaid, svg and html are taught
 * whole; chart keeps one line and every other type is one `render guide <type>` away. docs/hypermedia.md quotes it.
 */
export const HYPERMEDIA_INSTRUCTION = (fy: string): string =>
  [
    'Hypermedia: when you teach, explain, compare or walk through anything not straightforward — a flow, architecture, state machine, layout or change over time — show it in your reply as well as saying it. Do not overdo it: a simple answer stays plain text; one picture beats several.',
    'Always inline: never publish an artifact, page, gist or link to explain something unless the owner asks for one.',
    'Tell it as a short story the reader can drive: step-through Next buttons, sliders, toggles, tap to reveal, animated diagrams. One idea per step, short labels, gentle motion that honours prefers-reduced-motion.',
    'Write a fenced block whose info string is exactly fy-render: line 1 `type: <type>`, line 2 `alt: <one-line description>`, then a line `---`, then the payload.',
    '- mermaid: Mermaid source (flowchart TB, sequenceDiagram, …): top-down, short labels; auto-themed, so no %%{init}%% or colours.',
    '- svg: one self-contained <svg>…</svg> (CSS animation welcome); no script, foreignObject or external links.',
    '- html: a fragment with inline CSS and <script> for interaction (runs isolated); load nothing from the network.',
    `- chart: JSON/YAML {kind: bar|line|area|pie|…, x: […], series: [{name, data}]}; full spec: \`${fy} render guide chart\`.`,
    `- map, image, video, audio, pdf: \`${fy} render guide <type>\`.`,
    'Example:',
    '```fy-render',
    'type: mermaid',
    'alt: How a request flows',
    '---',
    'flowchart TB',
    '  Phone --> Relay --> Daemon',
    '```',
    "It renders inline in the reader's chat. Chat only: never write fy-render into files, docs, commits or PRs.",
  ].join('\n');

/**
 * PACK MODE — a per-FERRET section of the appended system prompt (docs/pack-mode.md): this ferret may
 * delegate to sub-ferrets and choose the model each runs on. The daemon writes {@link PACK_ENV} `0` for
 * a ferret at the deepest level a sub-ferret may start from, so it is never told about a door it cannot
 * open. docs/pack-mode.md quotes this text verbatim.
 */
export const PACK_ENV = 'FY_PACK';

/** The Pack mode teaching. Short on purpose — it is in every prompt. */
export const PACK_INSTRUCTION = (fy: string): string =>
  [
    `Pack mode: you may hand self-contained parts of your task to sub-ferrets — other agents, each on the model that suits its part. Prefer them over your built-in subagents for real work; do small things yourself. Pick each model by the Routing line below.`,
    `1. \`${fy} recommend\` lists the models usable now, most quota first, with the command to start each.`,
    `2. \`${fy} new --runtime <runtime> --model <model> [--effort <level>] --name "<short task title>" "<complete brief>"\` starts one (\`${fy} new --auto "<brief>"\` lets Ferretry choose). Always pass \`--name\` (2–5 Title Case words). The brief is all it knows: say what to do, where, and what to report.`,
    `3. If it refuses (out_of_quota, not_logged_in, cli_missing, probe_failed, …), read the reason and start the next candidate. limit_reached or depth_exceeded: do the work yourself.`,
    `4. \`${fy} wait <id>\` blocks until it finishes and prints its result. Check it, then combine the results yourself.`,
    `Stop sub-ferrets you no longer need (\`${fy} stop children <your id> --yes\`).`,
  ].join('\n');

/**
 * The ONE routing prompt (docs/pack-mode.md § The routing prompt), whole, as one `Routing: …` line appended
 * to the Pack section when Pack mode is on — the same text Jev decides with. The daemon renders it from the
 * prompt in effect at EVERY launch and never stores it, so a restart hears the latest saved prompt. It
 * carries no quote, backslash or control character, so it sits inside either harness's quoting unchanged —
 * and the wrapper strips them anyway, so a hand-set value cannot break a launch.
 */
export const PACK_ROUTING_ENV = 'FY_PACK_ROUTING';

/** One per-ferret section: the name a surface shows it by, the variable that turns it on, and its text. */
export interface FerretSection {
  readonly id: Extract<LaunchInstructionSectionId, 'hypermedia' | 'pack' | 'agenda' | 'learning'>;
  readonly env: string;
  readonly text: string;
  /** A switch that, when `1`, keeps the section out even though {@link env} is on: a sub-ferret has no agenda. */
  readonly unlessEnv?: string;
}

/** The per-ferret sections, in the order the wrapper appends them, each with the variable that turns it on. */
export const FERRET_SECTIONS = (fy: string): readonly FerretSection[] => [
  { id: 'hypermedia', env: HYPERMEDIA_ENV, text: HYPERMEDIA_INSTRUCTION(fy) },
  { id: 'pack', env: PACK_ENV, text: PACK_INSTRUCTION(fy) },
  { id: 'agenda', env: AGENDA_ENV, text: AGENDA_INSTRUCTION(fy), unlessEnv: SUB_FERRET_ENV },
  { id: 'learning', env: PASSIVE_LEARNING_ENV, text: LESSONS_INSTRUCTION(fy) },
];

/** The built-in instruction: the tools exist, and how names work. Short on purpose — it is in every prompt. */
export const AGENT_TOOLS_INSTRUCTION =
  'Ferretry tools: you can open and drive terminals and browser pages the person watches live, with the ferretry MCP tools (terminal_* and browser_*). Give each a short lowercase name such as dev or app; you and the person both write %terminal:dev or %browser:app, and each opens as a tab for them. Whenever you need the person to act (a sudo or password prompt, an OAuth or device-code login, gh auth login, 2FA, "press Enter", a TUI wizard, a web login, a captcha, a payment or consent screen), do not just describe it: open the terminal or page, drive it as far as you can, then call terminal_ask_owner or browser_ask_owner (or pass askOwner to open) saying exactly what to do there, and wait. Never put a secret in chat or in a tool call. If a tool says a person has taken a tab over, wait or ask them.';

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

/**
 * Changing Ferretry's own settings — the short form of the "Set up Ferretry" skill. The whole skill is
 * one command away (`fy config guide`), so it is not in every prompt; these are the rules an agent must
 * not learn too late.
 */
export const SET_UP_FERRETRY_INSTRUCTION = (fy: string): string =>
  `Ferretry settings: this machine's logins, MCP servers, skills, profiles, runtimes and its Warden, Learning, Voice and Pack settings are YAML files (\`${fy} config path\`). Before changing any, read \`${fy} config guide\` and follow it: never write a secret value into a file (\`${fy} secret set NAME\`, then \${secret:NAME}), run \`${fy} config check\` after every edit, and an edit that loosens what the machine may spend or what agents may do waits for the owner — tell them; never work around it.`;

/**
 * AGENDA MODE — a per-FERRET section (docs/agenda.md): this ferret keeps a list of what only the owner can
 * do or decide, and the daemon pushes the phone once when it stops with items waiting. Off unless the
 * daemon writes {@link AGENDA_ENV} `1`. docs/agenda.md quotes this text verbatim.
 */
export const AGENDA_ENV = 'FY_AGENDA';

/** The Agenda mode teaching. Short on purpose — it is in every prompt that turns it on. */
export const AGENDA_INSTRUCTION = (fy: string): string =>
  [
    `Agenda mode: keep an agenda of what ONLY the owner can do or decide. To ask them to decide or DO anything, add each ask as its OWN item: \`${fy} agenda add --title "<topic>" --premise "<situation>" --context "<why now>" "<the ask>"\` (required). Title ≤40 chars; ask ≤120. Read cold: no "as above", ticket/PR numbers, paths or unexplained acronyms (\`--term "X=meaning"\`).`,
    `Each item stands ALONE: full Markdown (\`code\` names, **bold** key point), \`--decided\` = settled, \`--still-open\` = left; \`--body\`: hypermedia (fy-render image|chart|mermaid|svg). \`--kind todo|yesno|permission|choice|review|info\`. Choice: 2–3 \`--option "Label: why"\`; \`--recommend <label> --recommend-why <line>\`. To-do: \`--step "<md>"\`.`,
    `\`--blocking\`: you cannot go on; \`--will-block\`: blocks later; \`--by <time>\`: when needed.`,
    `"[answer to !A3 …]" is the answer; "[re !A3 …]" is chat that closes it: re-raise (\`${fy} agenda surface <id>\`) only if the owner must still decide or act. KEEP ITEMS CURRENT this turn: agenda \`edit <id>\` if changed, \`done <id>\` if settled; \`ls\` = open.`,
  ].join('\n');

/**
 * NOTIFY — how an agent tells the human something outside a reply. Every agent runtime gets it, in a
 * rule short enough to sit in every prompt; the bigger, switchable teaching of an agenda is
 * {@link AGENDA_INSTRUCTION}. docs/notifications.md quotes this text verbatim.
 */
export const NOTIFY_INSTRUCTION = (fy: string): string =>
  `Notify: the owner reads the Inbox, not your replies. To tell them something worth their time (a result, a blocker, a decision you made for them) run \`${fy} notify "<summary>" [--body "<detail>"]\`: a quiet Inbox notice. Add \`--ping\` only when it must reach their phone now. Never notify progress or chatter.`;

/**
 * BOARD — when a ferret must make, move or leave a card on its project's board (`board-design.md` §3.2),
 * in every agent runtime's prompt. The board moves what a signal moves (a start, a PR, a release); this is
 * the rest, which only the ferret knows. The daemon's turn-end check backs it up (`board/turn-check.ts` in
 * the daemon). docs/board.md quotes this text verbatim.
 */
export const BOARD_INSTRUCTION = (fy: string): string =>
  `Board: all work is a card (&F412) on its project's board (new repo: \`${fy} project add .\`); agenda items are !A48. Before your first edit for a new ask, have one: \`${fy} task create -k <kind> -t "<≤5 words>" --summary "<line>" --ask "<owner's words verbatim>"\` (${fy} new/start make one). Move it: \`${fy} task move <id> <lane> --reason "<why>"\`. Blocked on owner: \`${fy} agenda add --task <id>\`; a card: \`${fy} task depend\`; outside: \`${fy} task block\`. Dropped: \`${fy} task drop --reason\`; switched: \`${fy} task focus <id>\`. Owner finds a problem: \`${fy} task reopen <id> --to <lane> --ask "<their words>"\`. Never move what a PR or release moves; only the owner closes.`;

/**
 * SUB-FERRET LIMITS (docs/pack-mode.md § Sub-ferret limits): a ferret another ferret started. The daemon
 * writes {@link SUB_FERRET_ENV} `1` from the session's `parent`, and the wrapper then swaps the notify and
 * board rules for {@link SUB_FERRET_INSTRUCTION} and leaves out the agenda section: the daemon refuses a
 * sub-ferret the agenda and the board's moves, so a prompt that taught them would only teach refusals.
 */
export const SUB_FERRET_ENV = 'FY_SUB_FERRET';

/** What a sub-ferret is told in place of the notify, board and agenda rules. Two lines on purpose. */
export const SUB_FERRET_INSTRUCTION = (fy: string): string =>
  [
    `Sub-ferret: you were started by a lead ferret. Report to it with \`${fy} send <lead-callsign> "<message>"\`; you cannot raise agenda items, notify the owner or move cards.`,
    `Link your PR to your card: \`${fy} task link <id> --pr <url>\` (or \`--branch\`); add progress with \`${fy} task note\`.`,
  ].join('\n');

/** What a lead is told after the base instruction: the notify rule, then the board rules. */
export const LEAD_RULES_INSTRUCTION = (fy: string): string => `${NOTIFY_INSTRUCTION(fy)}\n\n${BOARD_INSTRUCTION(fy)}`;

/**
 * What every agent runtime is told, whoever it is: the tools and the settings rules. The wrapper appends
 * a lead's {@link LEAD_RULES_INSTRUCTION} or a sub-ferret's {@link SUB_FERRET_INSTRUCTION} after it.
 */
export const AGENT_BASE_INSTRUCTION = (fy: string): string =>
  `${AGENT_TOOLS_INSTRUCTION}\n\n${SET_UP_FERRETRY_INSTRUCTION(fy)}`;

/**
 * Everything a LEAD agent is told, as ONE appended system prompt section: the tools, the settings rules,
 * the notify rule, then the board rules. A ferret's own sections follow it (`FERRET_SECTIONS`), added by
 * its wrapper.
 */
export const AGENT_INSTRUCTION = (fy: string): string =>
  `${AGENT_BASE_INSTRUCTION(fy)}\n\n${LEAD_RULES_INSTRUCTION(fy)}`;

/** One section every agent runtime is told, whatever its switches: its id and its exact text. */
export interface AlwaysOnSection {
  readonly id: 'tools' | 'settings' | 'notify' | 'board' | 'sub-ferret';
  readonly text: string;
}

/**
 * The sections of {@link AGENT_INSTRUCTION}, in order. They depend on nothing but the binary's name, so the
 * daemon can tell a running ferret what changed in them since its launch (docs/launch-settings.md).
 */
export const ALWAYS_ON_SECTIONS = (fy: string, subFerret = false): readonly AlwaysOnSection[] => [
  { id: 'tools', text: AGENT_TOOLS_INSTRUCTION },
  { id: 'settings', text: SET_UP_FERRETRY_INSTRUCTION(fy) },
  ...(subFerret
    ? [{ id: 'sub-ferret' as const, text: SUB_FERRET_INSTRUCTION(fy) }]
    : [
        { id: 'notify' as const, text: NOTIFY_INSTRUCTION(fy) },
        { id: 'board' as const, text: BOARD_INSTRUCTION(fy) },
      ]),
];

/**
 * A short fingerprint of a section's text (cyrb53, 14 hex digits): enough to tell that the words changed,
 * never enough to carry them. Pure, so the wrapper's description and the daemon's comparison agree.
 */
export function instructionDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * What an agent launched with `env` is told, by section name and size — never the text: the sections
 * of the ONE appended system prompt, in the order the wrapper composes them, and whether the question
 * tool is left in.
 *
 * Read off the same constants the wrapper renders (`../wrappers.ts`), so it cannot describe a prompt
 * the wrapper would not build: the tools, settings, notify and board sections always (each with its {@link instructionDigest}), each {@link FERRET_SECTIONS}
 * entry whose variable is exactly `1`, and the question tool only for a launch whose
 * {@link SESSION_MODE_ENV} is `interactive` (O3) — the same rule for Claude and Codex. It describes an
 * AGENT runtime's wrapper, the only kind a session can be started on.
 */
export function launchInstructions(fy: string, env: Readonly<Record<string, string>>): SessionLaunchInstructions {
  const mode = env[SESSION_MODE_ENV] === 'interactive' ? 'interactive' : 'auto';
  const subFerret = env[SUB_FERRET_ENV] === '1';
  return {
    sections: [
      ...ALWAYS_ON_SECTIONS(fy, subFerret).map(section => ({
        id: section.id,
        chars: section.text.length,
        digest: instructionDigest(section.text),
      })),
      ...FERRET_SECTIONS(fy)
        .filter(section => env[section.env] === '1' && !(subFerret && section.unlessEnv === SUB_FERRET_ENV))
        .map(section => {
          const routing = section.env === PACK_ENV ? (env[PACK_ROUTING_ENV] ?? '') : '';
          const text = routing === '' ? section.text : `${section.text}\n${routing}`;
          return { id: section.id, chars: text.length, digest: instructionDigest(text) };
        }),
    ],
    mode,
    questions: mode === 'interactive',
  };
}

/**
 * What the tools server says when an agent connects (MCP `initialize` instructions): one line. Every
 * behavioural instruction is in the appended system prompt instead, which a harness weighs far above
 * a server's instructions.
 */
export const TOOLS_SERVER_INSTRUCTIONS =
  "Ferretry's tools: terminals, browser pages, configuration and lessons. How to use them is in your system prompt.";

/** The binary's name, as an instruction names it: the last segment of the command a wrapper runs. */
export const binaryName = (fyCommand: string): string => fyCommand.split('/').pop() || fyCommand;

/** The fixed layer for an agent runtime of `input.harness`, or the reason it cannot launch (O4). */
export function fixedLayerFor(input: FixedLayerInput): FixedLayerResult {
  const { agentPermissions, cwd, fyCommand } = input;
  const instruction = AGENT_BASE_INSTRUCTION(binaryName(fyCommand));
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
      entry('remote-control', 'settings', [CLAUDE_REMOTE_CONTROL_KEY], false),
      ...Object.entries(CLAUDE_PROMPTS_SEEN).map(([key, value]) =>
        entry('one-time-prompts', 'claude-json', [key], value),
      ),
      ...(skip ? [] : [entry('skip-prompt', 'settings', ['skipAutoPermissionPrompt'], true)]),
      entry('no-questions', 'launch', [CLAUDE_NO_QUESTIONS_FLAG], true),
      entry('tools', 'launch', ['--mcp-config'], claudeToolsConfig(fyCommand)),
      entry('instructions', 'launch', ['--append-system-prompt'], instruction),
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
          `--append-system-prompt=${instruction}`,
        ],
        // The mode is named HERE too: the overlay is the flag settings source, and a mode named by one
        // is what keeps the auto-default dialog away (see the header).
        claudeSettingsOverlay: {
          permissions: { defaultMode: mode },
          [CLAUDE_REMOTE_CONTROL_KEY]: false,
          ...(skip ? { skipDangerousModePermissionPrompt: true } : { skipAutoPermissionPrompt: true }),
          hooks: CLAUDE_QUESTION_HOOKS,
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
        entry('instructions', 'settings', ['developer_instructions'], instruction),
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
        `developer_instructions=${tomlString(instruction)}`,
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
