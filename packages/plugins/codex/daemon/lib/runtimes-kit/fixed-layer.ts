/**
 * What Runtimes builds the layer a launched Codex agent gets last from (E-276 PR 3): the approval policy and sandbox, the
 * trusted launch folder, the hidden one-time notices, `--no-alt-screen`, the kill-deny rules file and the Ferretry tools
 * server. Runtimes owns the words every agent is told (`input.instruction`), the key each entry shows under and how the layer
 * is applied.
 */
import {
  FERRETRY_MCP_ARGS,
  FERRETRY_MCP_ENV_VARS,
  FERRETRY_MCP_SERVER,
  type KitAgentPermissions,
  type KitFixedEntry,
  type KitFixedLayerInput,
  type KitFixedLayerResult,
  type KitSettingsObject,
  type RuntimesHarnessKit,
  tomlString,
} from '@ferretry/plugin-runtimes/contract';

/**
 * The shell commands no ferret may run (E176, owner): a pattern kill (`pkill -f`) or a kill by name (`killall`) reaches every
 * process on the machine, not only the caller's. Codex refuses them as a `forbidden` prefix rule in the home's `rules/` folder,
 * which holds whatever the approval policy is and in the skip mode too. Settings, never a hook.
 */
const KILL_COMMANDS = ['pkill', 'killall'] as const;

/** Codex's rules (Starlark): one `forbidden` prefix rule per {@link KILL_COMMANDS}. */
const codexKillRules = (): string =>
  `${KILL_COMMANDS.map(
    command =>
      `prefix_rule(pattern=[${JSON.stringify(command)}], decision="forbidden", justification="${command} can stop other ferrets' processes; stop the one process you started instead")`,
  ).join('\n')}\n`;

/** Codex's spelling of each Agent permissions choice (§3.6). */
const CODEX_PERMISSIONS: Readonly<
  Record<KitAgentPermissions, { readonly approvalPolicy: string; readonly sandboxMode: string }>
> = {
  auto: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  skip: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
};

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

/** The unattended agent has no one to answer a full-screen terminal switch, so Codex stays inline. */
const CODEX_NO_ALT_SCREEN_FLAG = '--no-alt-screen';

/** The `-c notice={…}` inline table hiding every {@link CODEX_HIDDEN_NOTICES}. */
export const codexNoticeOverride = (): string =>
  `notice={${CODEX_HIDDEN_NOTICES.map(key => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)}=true`).join(',')}}`;

/** The measured Codex trust override for one folder: a TOML inline table, never a dotted key. */
export const codexTrustOverride = (cwd: string): string => `projects={${tomlString(cwd)}={trust_level="trusted"}}`;

/** Codex's `mcp_servers.ferretry` table for the tools server. */
export const codexToolsServer = (fyCommand: string): KitSettingsObject => ({
  command: fyCommand,
  args: [...FERRETRY_MCP_ARGS],
  env_vars: [...FERRETRY_MCP_ENV_VARS],
});

/** A TOML array of basic strings, for a `-c` override. */
const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(',')}]`;

const entry = (
  purpose: KitFixedEntry['purpose'],
  target: KitFixedEntry['target'],
  path: readonly string[],
  value: unknown,
): KitFixedEntry => ({ purpose, target, path, value });

/** The fixed layer for a Codex agent runtime. Codex has no refusal: every mode is one it accepts. */
function fixedLayer(input: KitFixedLayerInput): KitFixedLayerResult {
  const { agentPermissions, cwd, fyCommand, instruction } = input;
  const { approvalPolicy, sandboxMode } = CODEX_PERMISSIONS[agentPermissions];
  return {
    ok: true,
    layer: {
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
      rules: codexKillRules(),
    },
  };
}

/**
 * The permission flags Codex's fixed layer replaces. `value` flags take the next token as their value unless written
 * `--flag=value`; `config` is `-c key=value`, superseded only for the keys the layer sets.
 */
const SUPERSEDED_FLAGS = {
  '--dangerously-bypass-approvals-and-sandbox': 'bare',
  '--full-auto': 'bare',
  '--ask-for-approval': 'value',
  '-a': 'value',
  '--sandbox': 'value',
  '-s': 'value',
  '--config': 'config',
  '-c': 'config',
} as const;

/** What Runtimes builds the layer a launched Codex agent gets last from. */
export const codexFixedLayerKit: RuntimesHarnessKit = { fixedLayer, supersededFlags: SUPERSEDED_FLAGS };
