import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import type { HarnessConfig, HooksItem, SettingsItem } from '../../../contract/index.ts';
import { seededCommand } from './api-key-seed.ts';
import { fixedLayer } from './fixed-layer.ts';
import { deepMergeSettings } from './settings.ts';
import { startupModelArguments } from './startup.ts';

/**
 * WHAT A CLAUDE CODE HOME HOLDS AND HOW CLAUDE IS STARTED IN IT.
 *
 * A ferret's home is its `CLAUDE_CONFIG_DIR`: Claude Code reads `CLAUDE.md` there as its user-level memory (how
 * it takes instructions), `settings.json` for the settings and hooks items, the fixed `--settings` overlay and
 * the file `--mcp-config` names (MCP). Pure: the adapter writes the text through the ferret's `agent-homes` root.
 */

export const HOME_FILES = {
  memory: 'CLAUDE.md',
  settings: 'settings.json',
  overlay: 'launch-settings.json',
  claudeJson: '.claude.json',
  conversation: 'conversation.json',
  mcp: 'mcp.json',
} as const;

export interface HomeInputs {
  readonly folder: string;
  readonly permissionMode: HarnessConfig['permissionMode'];
  /** Instructions already filtered by `when` and ordered by Ferrets. */
  readonly instructions: readonly { readonly id: string; readonly text: string }[];
  readonly parts: readonly LaunchPart[];
  /** The settings items on this machine, by name (`config/claude-code/settings/<name>.yaml`). */
  readonly settings: ReadonlyMap<string, SettingsItem>;
  readonly hooks: ReadonlyMap<string, HooksItem>;
  readonly effort?: string | undefined;
  /** The start asked for (`true`) or against (`false`) the harness's fast mode; absent leaves Claude's own setting. */
  readonly fast?: boolean | undefined;
}

export interface HomeText {
  readonly memory: string;
  readonly settings: string;
  readonly overlay: string;
  readonly claudeJson: string;
  /** Absent when no MCP server was added to this launch. */
  readonly mcp?: string;
}

const byName = <T>(items: ReadonlyMap<string, T>): readonly T[] =>
  [...items.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);

/** The settings document: each item's settings in name order, each hooks item's hooks appended per event. */
export function settingsDocument(inputs: Pick<HomeInputs, 'settings' | 'hooks' | 'effort'>): Record<string, unknown> {
  let document: Record<string, unknown> = {};
  for (const item of byName(inputs.settings)) document = deepMergeSettings(document, item.settings);
  const hooks: Record<string, unknown[]> = {};
  const declared = document.hooks;
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared))
    for (const [event, list] of Object.entries(declared)) if (Array.isArray(list)) hooks[event] = [...list];
  for (const item of byName(inputs.hooks))
    for (const [event, list] of Object.entries(item.hooks)) hooks[event] = [...(hooks[event] ?? []), ...list];
  if (Object.keys(hooks).length > 0) document.hooks = hooks;
  // The start request's level is the one the home persists, where `/effort` would write it.
  if (inputs.effort !== undefined) document.effortLevel = inputs.effort;
  return document;
}

/** The text of every file a launch writes into the home. */
export function homeText(inputs: HomeInputs): HomeText {
  const fixed = fixedLayer(inputs.permissionMode, inputs.folder);
  const memory = [
    ...inputs.instructions.map(entry => entry.text.trim()),
    ...inputs.parts.flatMap(part => (part.kind === 'instruction' ? [part.text.trim()] : [])),
  ]
    .filter(text => text !== '')
    .join('\n\n');
  const servers = Object.fromEntries(
    inputs.parts.flatMap(part => (part.kind === 'mcp' ? [[part.name, part.config]] : [])),
  );
  // A login's literal environment, pinned where a project's own `.claude/settings*.json` cannot replace it: the
  // `--settings` file outranks a project's `env`, the process environment does not (#1587).
  const pinned = Object.assign({}, ...inputs.parts.flatMap(part => (part.kind === 'pin' ? [part.env] : [])));
  // The compaction trigger a login publishes (a `compact` part), where Claude reads it: `autoCompactWindow`.
  const compactAt = inputs.parts.flatMap(part => (part.kind === 'compact' ? [part.at] : [])).at(-1);
  const overlay = {
    ...fixed.overlay,
    ...(Object.keys(pinned).length === 0 ? {} : { env: pinned }),
    ...(inputs.fast === undefined ? {} : { fastMode: inputs.fast }),
    ...(compactAt === undefined ? {} : { autoCompactWindow: compactAt }),
  };
  return {
    memory: memory === '' ? '' : `${memory}\n`,
    settings: `${JSON.stringify(deepMergeSettings(settingsDocument(inputs), fixed.settings), null, 2)}\n`,
    overlay: `${JSON.stringify(overlay, null, 2)}\n`,
    claudeJson: `${JSON.stringify(fixed.claudeJson, null, 2)}\n`,
    ...(Object.keys(servers).length === 0 ? {} : { mcp: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` }),
  };
}

export interface CommandInputs {
  readonly binary: string;
  /** The ferret's home, which is Claude's `CLAUDE_CONFIG_DIR`. */
  readonly home: string;
  readonly permissionMode: HarnessConfig['permissionMode'];
  readonly model?: string | undefined;
  readonly hasMcp: boolean;
  /** The conversation id: assigned at a start (Claude takes `--session-id`), named at a resume. */
  readonly conversation: { readonly kind: 'new' | 'resume'; readonly id: string };
  /** The absolute folders Ferrets lets this ferret read without asking (`LaunchSpec.readable`). */
  readonly readable?: readonly string[] | undefined;
}

/**
 * What lets the agent open the folders it is pointed into to read what it was sent WITHOUT ASKING, and lets it do
 * nothing else there (today's `handoffReadArguments`, copied). Every one of them is outside the agent's working folder,
 * so Claude Code asks before reading a turn document or an attached image (in `default` and `acceptEdits`; `auto` hands
 * it to its classifier), which stops an agent at its first turn to ask permission to read it. A `Read(…)` allow rule
 * answers read checks only: Claude never derives a write from it, unlike `--add-dir`. The `//` prefix is Claude's
 * spelling of an absolute path (a single `/` is relative to the settings file), and the `=` form keeps the variadic
 * flag from swallowing the arguments after it. A folder that is not absolute is never allowed.
 */
export function readAllowArguments(folders: readonly string[]): readonly string[] {
  return folders.filter(folder => folder.startsWith('/')).map(folder => `--allowedTools=Read(/${folder}/**)`);
}

/**
 * The argv that starts Claude in a home. `env` carries the one variable the home needs, so the Vault-resolved
 * environment the runner starts it with stays whole; Claude then starts through the child-side API-key seed
 * (`api-key-seed.ts`), a fixed `sh -c` script that reads the key only from its own environment and `exec`s claude.
 * The model goes LAST among the flags so the daemon's explicit decision wins; the permission mode is `auto` (ask
 * before anything risky) or `bypassPermissions`.
 */
export function launchCommand(inputs: CommandInputs): readonly string[] {
  return ['env', `CLAUDE_CONFIG_DIR=${inputs.home}`, ...seededCommand(claudeCommand(inputs))];
}

/** Claude itself and its flags: what the seed `exec`s. */
function claudeCommand(inputs: CommandInputs): readonly string[] {
  return [
    inputs.binary,
    '--settings',
    `${inputs.home}/${HOME_FILES.overlay}`,
    '--permission-mode',
    inputs.permissionMode === 'skip' ? 'bypassPermissions' : 'auto',
    ...(inputs.hasMcp ? ['--mcp-config', `${inputs.home}/${HOME_FILES.mcp}`] : []),
    inputs.conversation.kind === 'new' ? '--session-id' : '--resume',
    inputs.conversation.id,
    ...readAllowArguments(inputs.readable ?? []),
    ...(inputs.model === undefined ? [] : startupModelArguments(inputs.model)),
  ];
}
