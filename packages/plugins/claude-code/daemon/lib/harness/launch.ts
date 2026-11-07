import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import type { HarnessConfig, HooksItem, SettingsItem } from '../../../contract/index.ts';
import { startupModelArguments } from './startup.ts';

/**
 * WHAT A CLAUDE CODE HOME HOLDS AND HOW CLAUDE IS STARTED IN IT.
 *
 * A ferret's home is its `CLAUDE_CONFIG_DIR`: Claude Code reads `CLAUDE.md` there as its user-level memory (how
 * it takes instructions), the file `--settings` names as an overlay (the settings and hooks items, as data) and
 * the file `--mcp-config` names (MCP). Pure: the adapter writes the text through the ferret's `agent-homes` root.
 */

export const HOME_FILES = { memory: 'CLAUDE.md', settings: 'settings.json', mcp: 'mcp.json' } as const;

export interface HomeInputs {
  /** Instructions already filtered by `when` and ordered by Ferrets. */
  readonly instructions: readonly { readonly id: string; readonly text: string }[];
  readonly parts: readonly LaunchPart[];
  /** The settings items on this machine, by name (`config/claude-code/settings/<name>.yaml`). */
  readonly settings: ReadonlyMap<string, SettingsItem>;
  readonly hooks: ReadonlyMap<string, HooksItem>;
  readonly effort?: string | undefined;
}

export interface HomeText {
  readonly memory: string;
  readonly settings: string;
  /** Absent when no MCP server was added to this launch. */
  readonly mcp?: string;
}

const byName = <T>(items: ReadonlyMap<string, T>): readonly T[] =>
  [...items.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);

/** The settings document: each item's settings in name order, each hooks item's hooks appended per event. */
export function settingsDocument(inputs: Pick<HomeInputs, 'settings' | 'hooks' | 'effort'>): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const item of byName(inputs.settings)) Object.assign(document, item.settings);
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
  const memory = [
    ...inputs.instructions.map(entry => entry.text.trim()),
    ...inputs.parts.flatMap(part => (part.kind === 'instruction' ? [part.text.trim()] : [])),
  ]
    .filter(text => text !== '')
    .join('\n\n');
  const servers = Object.fromEntries(inputs.parts.flatMap(part => (part.kind === 'mcp' ? [[part.name, part.config]] : [])));
  return {
    memory: memory === '' ? '' : `${memory}\n`,
    settings: `${JSON.stringify(settingsDocument(inputs), null, 2)}\n`,
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
}

/**
 * The argv that starts Claude in a home. `env` carries the one variable the home needs, so the Vault-resolved
 * environment the runner starts it with stays whole. The model goes LAST among the flags so the daemon's
 * explicit decision wins; the permission mode is `auto` (ask before anything risky) or `bypassPermissions`.
 */
export function launchCommand(inputs: CommandInputs): readonly string[] {
  return [
    'env',
    `CLAUDE_CONFIG_DIR=${inputs.home}`,
    inputs.binary,
    '--settings',
    `${inputs.home}/${HOME_FILES.settings}`,
    '--permission-mode',
    inputs.permissionMode === 'skip' ? 'bypassPermissions' : 'auto',
    ...(inputs.hasMcp ? ['--mcp-config', `${inputs.home}/${HOME_FILES.mcp}`] : []),
    inputs.conversation.kind === 'new' ? '--session-id' : '--resume',
    inputs.conversation.id,
    ...(inputs.model === undefined ? [] : startupModelArguments(inputs.model)),
  ];
}
