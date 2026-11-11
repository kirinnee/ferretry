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
  /** The login's environment for this launch (`LaunchSpec.loginEnv`): names, literals and `${secret:}` references. */
  readonly loginEnv?: Readonly<Record<string, string>> | undefined;
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

/**
 * Names a pin never carries: Ferrets' own (`FY_*`), the ferret's home and Claude's store selector. Ferrets already
 * keeps them out of `loginEnv`; this is the second lock, because a pin lives in a file.
 */
const NEVER_PINNED: ReadonlySet<string> = new Set(['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']);

/** A value with a `$` that names something: `${…}` (a secret reference, either spelling, or `${NAME}`) or `$NAME`. */
const REFERENCE = /\$\{|\$[A-Za-z_]/u;

/**
 * The login's LITERAL provider values to pin in the launch overlay (B190). Claude applies a settings file's `env` over
 * the process environment, so a repository's `.claude/settings.local.json` can undo (or blank) a login's base URL; the
 * `--settings` overlay outranks that file. A key is pinned only when
 *
 * - its value is a plain literal: never a `${secret:…}` / `${secret?:…}` reference (a secret never goes into a
 *   file; it stays child environment, which a repo can still blank), and never `$NAME` / `${NAME}` (the child's shell
 *   would expand those, a settings file would not, so the pin would be the TEXT `$NAME`);
 * - it is not `FY_*`, `HOME`, `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR`;
 * - the child's final value for it IS the login's value: a later `env`/`shell` part (profile, MCP, shell) that sets the
 *   key to something else wins in the child, so pinning the login's value would flip that order;
 * - the merged settings document does not set it in its own `env` (B1): that block lands in the home's `settings.json`,
 *   which `--settings` outranks, so a pin would flip the document's precedence over the process environment.
 */
export function loginEnvPins(
  loginEnv: Readonly<Record<string, string>> | undefined,
  parts: readonly LaunchPart[],
  documentEnv: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const [name, value] of Object.entries(loginEnv ?? {})) {
    if (name.startsWith('FY_') || NEVER_PINNED.has(name) || REFERENCE.test(value) || Object.hasOwn(documentEnv, name))
      continue;
    let final = value;
    for (const part of parts)
      if ((part.kind === 'env' || part.kind === 'shell') && name in part.env) final = part.env[name] as string;
    if (final === value) pins[name] = value;
  }
  return pins;
}

/**
 * The launch overlay: the fixed layer, with the pins beneath it (`{ ...pins, ...fixed.env }`, so the fixed layer wins).
 * Refuses to build a document that would carry a secret reference anywhere, because this file is plain text in the
 * agent home.
 *
 * The guard is on THIS file only, on purpose (ruling B2). A reference is a NAME, not a value: a settings item, an MCP
 * config or an instruction legitimately carries `${secret:NAME}` and reaches its file as that literal text, which
 * resolves nothing (the Vault resolves a reference only into a child's environment). What this file must never hold is
 * a pin the login contributed, and the pins already exclude every reference, so a throw here means a bug, not input.
 */
export function overlayDocument(
  fixed: Readonly<Record<string, unknown>>,
  pins: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const fixedEnv = typeof fixed.env === 'object' && fixed.env !== null ? (fixed.env as Record<string, unknown>) : {};
  const env = { ...pins, ...fixedEnv };
  const document = { ...fixed, ...(Object.keys(env).length === 0 ? {} : { env }) };
  if (/\$\{secret/u.test(JSON.stringify(document)))
    throw new Error('the launch overlay would carry a secret reference, which must stay in the child environment');
  return document;
}

/** The `env` block of a settings document, which lands in the home's `settings.json`. */
function documentEnvOf(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { env } = document;
  return typeof env === 'object' && env !== null && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
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
  const settings = deepMergeSettings(settingsDocument(inputs), fixed.settings);
  const pins = loginEnvPins(inputs.loginEnv, inputs.parts, documentEnvOf(settings));
  return {
    memory: memory === '' ? '' : `${memory}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    overlay: `${JSON.stringify(overlayDocument(fixed.overlay, pins), null, 2)}\n`,
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
