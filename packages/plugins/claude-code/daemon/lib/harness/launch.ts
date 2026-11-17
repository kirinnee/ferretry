import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import {
  CHANNEL_AGENT_INSTRUCTION,
  CLAUDE_CHANNELS_FLAG,
  channelToolsServer,
  claudeChannelsFor,
  FERRETRY_MCP_SERVER,
} from '@ferretry/plugin-runtimes/contract';
import { type HarnessConfig, type HooksItem, launchFlagsKept, type SettingsItem } from '../../../contract/index.ts';
import { seededCommand } from './api-key-seed.ts';
import {
  CLAUDE_HOME_ENV,
  CLAUDE_PROMPT_ENV,
  CLAUDE_RM_WAIVER_ENV,
  CLAUDE_UNSET_ENV,
  fixedLayer,
  rmWaiverApplies,
} from './fixed-layer.ts';
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
  /**
   * The ferret is launched with Ferretry's message channel (see {@link channelsOn}): the tools server is added to its MCP
   * servers (run as {@link HomeInputs.fyCommand}, with the launch marker) and its memory says how to treat channel messages.
   */
  readonly channels?: boolean | undefined;
  /** The `fy` executable the tools server runs as; read only with {@link HomeInputs.channels}. */
  readonly fyCommand?: string | undefined;
}

/**
 * Whether a launch gets the channel: the `channels` setting when it is written, otherwise only a login whose own account file
 * says `claude_max` (the `account` part Runtimes adds). Team, Enterprise, any other type and an unknown one are OFF: a refused
 * channel would only cost every message a receipt window before it was typed.
 */
export const channelsOn = (explicit: boolean | undefined, parts: readonly LaunchPart[]): boolean =>
  claudeChannelsFor(explicit, parts.flatMap(part => (part.kind === 'account' ? [part.organizationType] : [])).at(-1));

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
    ...(inputs.channels === true ? [CHANNEL_AGENT_INSTRUCTION] : []),
  ]
    .filter(text => text !== '')
    .join('\n\n');
  const servers = {
    ...Object.fromEntries(inputs.parts.flatMap(part => (part.kind === 'mcp' ? [[part.name, part.config]] : []))),
    // Ours is added LAST: a profile's own server of that name never replaces the one the channel is loaded from.
    ...(inputs.channels === true
      ? { [FERRETRY_MCP_SERVER]: channelToolsServer(inputs.fyCommand ?? 'fy') as never }
      : {}),
  };
  const settings = deepMergeSettings(settingsDocument(inputs), fixed.settings);
  // The compaction trigger a login publishes (a `compact` part), where Claude reads it: `autoCompactWindow`.
  const compactAt = inputs.parts.flatMap(part => (part.kind === 'compact' ? [part.at] : [])).at(-1);
  const overlay = {
    ...fixed.overlay,
    ...(inputs.fast === undefined ? {} : { fastMode: inputs.fast }),
    ...(compactAt === undefined ? {} : { autoCompactWindow: compactAt }),
  };
  return {
    memory: memory === '' ? '' : `${memory}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    overlay: `${JSON.stringify(overlay, null, 2)}\n`,
    claudeJson: `${JSON.stringify(fixed.claudeJson, null, 2)}\n`,
    ...(Object.keys(servers).length === 0 ? {} : { mcp: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` }),
  };
}

/**
 * The launch flags the selected settings items carry, item by item in name order (the order their settings merge in, so
 * the later item's flag comes later on the command line). Every word is its own argv word, whatever it holds.
 */
export const settingsFlags = (settings: ReadonlyMap<string, SettingsItem>): readonly string[] =>
  byName(settings).flatMap(item => item.flags ?? []);

export interface CommandInputs {
  readonly binary: string;
  /** The settings items' launch flags ({@link settingsFlags}): passed first, so every flag the launch sets wins. */
  readonly flags?: readonly string[] | undefined;
  /** The ferret's home, which is Claude's `CLAUDE_CONFIG_DIR`. */
  readonly home: string;
  readonly permissionMode: HarnessConfig['permissionMode'];
  readonly model?: string | undefined;
  readonly hasMcp: boolean;
  /** Ferretry's message channel is loaded (see {@link HomeInputs.channels}): its flag is on the argv and the MCP file is named. */
  readonly channels?: boolean | undefined;
  /** `HarnessConfig.dangerousRmWaiver`: with bypass mode, the one way the full dangerous-rm waiver is set. */
  readonly dangerousRmWaiver?: HarnessConfig['dangerousRmWaiver'] | undefined;
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
  const waiver = rmWaiverApplies(inputs.dangerousRmWaiver ?? false, inputs.permissionMode) ? CLAUDE_RM_WAIVER_ENV : {};
  const fixed = Object.entries({ ...CLAUDE_HOME_ENV, ...CLAUDE_PROMPT_ENV, ...waiver }).map(
    ([name, value]) => `${name}=${value}`,
  );
  // `-u` first: `env` takes its options before the assignments.
  const unset = CLAUDE_UNSET_ENV.flatMap(name => ['-u', name]);
  return ['env', ...unset, `CLAUDE_CONFIG_DIR=${inputs.home}`, ...fixed, ...seededCommand(claudeCommand(inputs))];
}

/** Claude itself and its flags: what the seed `exec`s. */
function claudeCommand(inputs: CommandInputs): readonly string[] {
  const itemFlags = launchFlagsKept(inputs.flags ?? []);
  return [
    inputs.binary,
    // The items' flags come BEFORE every flag the launch sets: Claude takes the last of a repeated flag, and the ones the
    // launch decides (permission mode, conversation, settings and MCP files) are dropped from them (`launchFlagsKept`).
    ...itemFlags,
    // A flag the items leave valueless at their end (`--model`, `--add-dir`) takes the NEXT word whatever it is. This
    // disposable copy of the overlay, one attached word, is what it takes; the real pair after it is never eaten.
    ...(itemFlags.length === 0 ? [] : [`--settings=${inputs.home}/${HOME_FILES.overlay}`]),
    // The channel's flag, with `=` (the option takes several servers; a bare one would swallow the arguments after it).
    ...(inputs.channels === true ? [CLAUDE_CHANNELS_FLAG] : []),
    '--settings',
    `${inputs.home}/${HOME_FILES.overlay}`,
    '--permission-mode',
    inputs.permissionMode === 'skip' ? 'bypassPermissions' : 'auto',
    CLAUDE_NO_QUESTIONS_FLAG,
    ...(inputs.hasMcp || inputs.channels === true ? ['--mcp-config', `${inputs.home}/${HOME_FILES.mcp}`] : []),
    inputs.conversation.kind === 'new' ? '--session-id' : '--resume',
    inputs.conversation.id,
    ...readAllowArguments(inputs.readable ?? []),
    ...(inputs.model === undefined ? [] : startupModelArguments(inputs.model)),
  ];
}

/**
 * The question tool (owner !A527, again 2026-11-17: "make sure ferrets dont use question tool"): WITHHELD from EVERY ferret,
 * interactive or auto, with no setting to turn it back on, so none stops on a form only the pane shows; an agent asks
 * through the agenda instead. Not part of the fixed layer's fingerprint, so it never reads a ferret as outdated.
 */
export const CLAUDE_NO_QUESTIONS_FLAG = '--disallowed-tools=AskUserQuestion';
