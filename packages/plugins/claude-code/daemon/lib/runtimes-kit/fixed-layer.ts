/**
 * What Runtimes builds the layer a launched Claude agent gets last from (E-276 PR 2): the permission mode, the one-time
 * screens recorded as seen, the kill-deny rules, the question flag and the Ferretry tools server. Runtimes owns the
 * words every agent is told (`input.instruction`), the key each entry shows under, and how the layer is applied.
 */
import {
  FERRETRY_MCP_ARGS,
  FERRETRY_MCP_SERVER,
  type KitAgentPermissions,
  type KitFixedEntry,
  type KitFixedLayerInput,
  type KitFixedLayerResult,
  type KitSettingsObject,
  type RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';
import { CLAUDE_PROMPTS_SEEN } from '../harness/fixed-layer.ts';
import { CLAUDE_NO_QUESTIONS_FLAG } from '../harness/launch.ts';

/**
 * The shell commands no ferret may run (E176, owner): a pattern kill (`pkill -f`) or a kill by name (`killall`) reaches every
 * process on the machine, not only the caller's. Claude refuses them as `permissions.deny` in the `--settings` overlay, which
 * outranks every file a person can edit and holds in the skip mode too. Settings, never a hook.
 */
const KILL_COMMANDS = ['pkill', 'killall'] as const;

/** Claude's `permissions.deny` rules for {@link KILL_COMMANDS}, with any arguments. */
const CLAUDE_KILL_DENY: readonly string[] = KILL_COMMANDS.map(command => `Bash(${command}:*)`);

/** Claude's spelling of each Agent permissions choice (§3.6). */
const CLAUDE_PERMISSION_MODES: Readonly<Record<KitAgentPermissions, string>> = {
  auto: 'auto',
  skip: 'bypassPermissions',
};

/** Claude's "start Remote Control in every session" preference. */
const CLAUDE_REMOTE_CONTROL_KEY = 'remoteControlAtStartup';

const AUTO_MODE_REFUSAL =
  "Claude Code on this machine does not accept Auto mode (--permission-mode auto), so Ferretry won't launch this agent runtime. Update Claude Code, or switch this machine's Agent permissions to Skip all permission checks.";

/** Claude's `--mcp-config` document for the tools server: a JSON string, so no file has to exist. */
export const claudeToolsConfig = (fyCommand: string): KitSettingsObject => ({
  mcpServers: {
    [FERRETRY_MCP_SERVER]: {
      type: 'stdio',
      command: fyCommand,
      args: [...FERRETRY_MCP_ARGS],
      // Claude passes a stdio server the agent's whole environment; the admin token must not be in it.
      env: {
        FY_TOKEN: '',
      },
    },
  },
});

const entry = (
  purpose: KitFixedEntry['purpose'],
  target: KitFixedEntry['target'],
  path: readonly string[],
  value: unknown,
): KitFixedEntry => ({ purpose, target, path, value });

/** The fixed layer for a Claude agent runtime, or the reason it cannot launch (O4). */
function fixedLayer(input: KitFixedLayerInput): KitFixedLayerResult {
  const { agentPermissions, cwd, fyCommand, instruction } = input;
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
      // is what keeps the auto-default dialog away (a mode only the settings entry names parks a launch on Claude's dialog).
      settingsOverlay: {
        permissions: { defaultMode: mode, deny: CLAUDE_KILL_DENY },
        [CLAUDE_REMOTE_CONTROL_KEY]: false,
        ...(skip ? { skipDangerousModePermissionPrompt: true } : { skipAutoPermissionPrompt: true }),
      },
      configJson: {
        hasCompletedOnboarding: true,
        ...CLAUDE_PROMPTS_SEEN,
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      },
    },
  };
}

/** What Runtimes builds the layer a launched Claude agent gets last from. */
export const claudeFixedLayerKit: RuntimesHarnessKit = { fixedLayer };
