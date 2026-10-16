/**
 * Component adaptation — how a profile resolved for one harness becomes that harness's own files
 * (docs/design/account-model.md §8.3, K2, K5, E22).
 *
 * Instructions, MCP servers and Skills are GENERIC: one component, written once, that each harness
 * reads in its own native form. Settings and Hooks belong to one harness and are rendered into that
 * harness's documents. This module owns that translation and nothing else:
 *
 * | Component    | Claude Code (in the runtime's config directory)    | Codex (in the runtime's config directory)      |
 * | ------------ | -------------------------------------------------- | ---------------------------------------------- |
 * | Instructions | `CLAUDE.md`: a link for one, generated for several | `AGENTS.md`, the same rule                     |
 * | MCP servers  | `mcpServers` in `.claude.json`                     | `[mcp_servers.<name>]` in `config.toml`        |
 * | Skills       | `skills/<item>`, one link per item                 | `skills/<item>`, one link per item             |
 * | Settings     | `settings.json`, deep-merged                       | `config.toml`, deep-merged                     |
 * | Hooks        | the `hooks` block of `settings.json`               | `hooks.json` (link for one, generated for more) |
 *
 * Every destination name is read from `../assets.ts`'s per-harness table, the one owner of where a
 * harness expects a document, so version 1 and version 2 can never disagree about a path.
 *
 * **Link or generate.** A destination with ONE source is a link into the asset tree, so editing the
 * component changes every runtime at once (K1); a source outside the tree is a copy, by the same
 * {@link isAssetTreeReference} rule the version-1 plan uses. A destination with SEVERAL sources is
 * generated, because a merge of N files cannot be a link to any of them.
 *
 * **Plumbing keys** are written into every runtime, agent or not, and are never a layer because they
 * are not behaviour: Claude's `statusLine.command` (the usage tee, which chains the person's own
 * statusLine command — spelled by the caller's {@link ClaudeStatuslineCommand}, never here), and
 * Codex's `cli_auth_credentials_store = "file"` and `sqlite_home`. A user value a plumbing key
 * replaces is reported, never silently lost.
 *
 * **Partial support** (K5, E22) is a declared table per kind ({@link componentPartialSupport}), the
 * input `./layering.ts` takes as `partialSupport`. It is decided from facts the caller read — a skill's
 * frontmatter keys, an instructions body — so this module stays pure.
 *
 * **Harness-owned entries.** Codex writes its bundled skills into `skills/.system/`; the result names
 * every such path in {@link AdaptedRuntime.harnessOwned} so a materialiser never sweeps it, and an
 * item of that name is refused rather than allowed to replace it.
 *
 * A secret never becomes a value here. An MCP server whose environment names a `${secret:NAME}` gets
 * that variable FORWARDED from the launch environment by name — Claude expands `${VAR}` in a server's
 * `env`, Codex forwards the names in `env_vars` (both INFERRED, CI-guarded with the rest of §8.5) — and
 * the reference itself goes to {@link AdaptedRuntime.launchEnv}, which the launch resolves exactly as
 * it resolves a Settings component's `env`.
 *
 * Pure and total: bodies are parsed by the caller, every failure is a {@link AdaptProblem}.
 */
import { mcpOAuthSecretNames, secretReference, secretReferencesIn } from '@ferretry/protocol';
import { harnessAsset, HARNESS_ASSETS, HARNESS_OWNED_SKILL_ENTRIES, type HarnessAssetTable } from '../assets.ts';
import type { HarnessKind } from '../manifest.ts';
import { isAssetTreeReference } from '../paths.ts';
import { deepMergeSettings, type SettingsFormat, type SettingsObject, serializeSettings } from '../settings.ts';
import { CODEX_CREDENTIAL_STORE_FILE, CODEX_CREDENTIAL_STORE_KEY } from './credentials.ts';
import {
  type Contribution,
  type FlatLayer,
  HARNESS_DISPLAY_NAMES,
  type PartialSupport,
  pathsOverlap,
  type ResolvedProfile,
  type SettingLeaf,
  sameSettingsValue,
} from './layering.ts';
import type { Components, LayerReferenceText, McpComponent } from './schema.ts';

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Claude's statusLine command for this runtime, given the person's own command when their settings
 * name one. The caller binds it to `claudeStatuslineCommand(binary, ownCommand)` (`../usage.ts`), so
 * the usage tee is spelled in exactly one place.
 */
export type ClaudeStatuslineCommand = (ownCommand?: string) => string;

/** The plumbing facts only the caller knows, per harness. */
export type AdaptPlumbing =
  | { readonly harness: 'claude'; readonly statusLine: ClaudeStatuslineCommand }
  | {
      readonly harness: 'codex';
      /** The shared history pool's SQLite directory (`CODEX_SQLITE_HOME`), so every runtime shares it. */
      readonly sqliteHome: string;
    };

/** Component bodies the caller read, by component name. */
export interface ComponentBodies {
  /** Instructions text. Needed only when a runtime has several instructions to concatenate. */
  readonly instructions?: Readonly<Record<string, string>>;
  /** Each hooks component's parsed `file`. */
  readonly hooks?: Readonly<Record<string, SettingsObject>>;
}

export interface AdaptInput {
  readonly resolved: ResolvedProfile;
  readonly plumbing: AdaptPlumbing;
  readonly bodies?: ComponentBodies;
  /**
   * The settings to render, when they are not the profile's own: an agent runtime passes
   * `applyFixedLayer(...).settings` (`./fixed-layer.ts`), so the fixed layer's keys are in the file too.
   */
  readonly settings?: SettingsObject;
  /** Defaults to {@link HARNESS_ASSETS}; injected so a caller can substitute one. */
  readonly assets?: HarnessAssetTable;
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────────

/** One document placed in the runtime's config directory. `dest` is relative to that directory. */
export type AdaptedEntry =
  | {
      /** `link`: the destination IS the component's file. `copy`: a source outside the asset tree. */
      readonly kind: 'link' | 'copy';
      readonly dest: string;
      /** The reference as written in the component, relative to the asset tree unless absolute. */
      readonly source: string;
      readonly from: readonly LayerReferenceText[];
    }
  | {
      readonly kind: 'generated';
      readonly dest: string;
      readonly content: string;
      readonly from: readonly LayerReferenceText[];
    };

/** A key written into every runtime that is not behaviour (§8.3), and so never shown as a layer. */
export interface PlumbingEntry {
  readonly key: string;
  readonly path: readonly string[];
  readonly value: unknown;
}

/** A value from the profile's settings that adaptation replaced. Information, as a conflict is. */
export interface AdaptOverride {
  readonly key: string;
  readonly path: readonly string[];
  readonly value: unknown;
  readonly layer: FlatLayer;
  /** What replaced it: a plumbing key, or the MCP component of the same server name. */
  readonly by: 'plumbing' | LayerReferenceText;
}

/** Why a runtime's files cannot be written as asked. Each one blocks the materialisation. */
export type AdaptProblem =
  | { readonly kind: 'harness-mismatch'; readonly message: string }
  | { readonly kind: 'unread'; readonly reference: LayerReferenceText; readonly message: string }
  | {
      readonly kind: 'reserved-skill-item';
      readonly item: string;
      readonly reference: LayerReferenceText;
      readonly message: string;
    }
  | {
      readonly kind: 'invalid-hooks';
      readonly reference: LayerReferenceText;
      readonly event: string;
      readonly message: string;
    }
  | {
      readonly kind: 'several-hook-directories';
      readonly references: readonly LayerReferenceText[];
      readonly message: string;
    }
  | {
      readonly kind: 'mcp-env-collision';
      readonly variable: string;
      readonly references: readonly LayerReferenceText[];
      readonly message: string;
    };

/** Everything one runtime's config directory gets from its profile. */
export interface AdaptedRuntime {
  readonly harness: HarnessKind;
  /** Instructions, skill items, and hooks documents or folders, in that order. */
  readonly entries: readonly AdaptedEntry[];
  /**
   * Destinations this profile puts nothing at, so a materialiser removes what an earlier version of
   * the profile left there. The skills folder is never one: its items are swept per item, sparing
   * {@link AdaptedRuntime.harnessOwned}.
   */
  readonly absent: readonly string[];
  /** The harness's settings document (`settings.json` / `config.toml`), plumbing included. */
  readonly settings: { readonly dest: string; readonly format: SettingsFormat; readonly value: SettingsObject };
  /**
   * Claude only: top-level keys of the config directory's `.claude.json`, each REPLACED whole before
   * launch. `mcpServers` is always present, so a server removed from the profile leaves the file too.
   */
  readonly claudeJson?: SettingsObject;
  /** Variables the launch environment must carry, each a value or a `${secret:NAME}` reference. */
  readonly launchEnv: Readonly<Record<string, string>>;
  /** Paths under the config directory the harness owns. Never removed, replaced or swept. */
  readonly harnessOwned: readonly string[];
  readonly plumbing: readonly PlumbingEntry[];
  readonly overrides: readonly AdaptOverride[];
  /** Empty when the runtime can be materialised. */
  readonly problems: readonly AdaptProblem[];
}

// ── Destinations ─────────────────────────────────────────────────────────────────────────────────

/** The skills store: an item named `review` lives at `skills/review` in the asset tree. */
export const SKILLS_STORE_DIRECTORY = 'skills';

/** Where a skill item lives in the asset tree. */
export const skillSourceReference = (item: string): string => `${SKILLS_STORE_DIRECTORY}/${item}`;

/** The config directory's own `.claude.json`, where Claude reads user-scope MCP servers. */
export const CLAUDE_JSON_FILE = '.claude.json';

/**
 * Where a folder of hook scripts lands. Codex's comes from `../assets.ts`; Claude has none there,
 * because version 1 never delivered one, so it takes the same name.
 */
const HOOK_SCRIPTS_FALLBACK_DEST = 'hooks';

/** Where a hooks document lands as its own file. Claude has none: its hooks live in `settings.json`. */
const hooksFileDest = (assets: HarnessAssetTable, harness: HarnessKind): string | undefined =>
  harnessAsset(assets, harness, 'hooks')?.dest;

const destOf = (assets: HarnessAssetTable, harness: HarnessKind, field: 'memory' | 'skills' | 'settings') =>
  // Present for both harnesses by the table's own declaration.
  harnessAsset(assets, harness, field) as NonNullable<ReturnType<typeof harnessAsset>>;

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nested = (path: readonly string[], value: unknown): SettingsObject =>
  [...path].reverse().reduce<unknown>((inner, segment) => ({ [segment]: inner }), value) as SettingsObject;

const quoted = (references: readonly string[]): string => references.map(reference => `"${reference}"`).join(', ');

// ── Instructions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Several instructions as the one generated document a harness reads: oldest first, so newer
 * guidance is read last (§3.4), under a line that says where to edit them instead.
 */
export function concatenateInstructions(
  parts: readonly { readonly reference: LayerReferenceText; readonly body: string }[],
): string {
  const header = `<!-- Generated from ${parts.map(part => part.reference).join(', ')}. Edit those components, not this file. -->`;
  return `${[header, ...parts.map(part => part.body.trim())].join('\n\n')}\n`;
}

function adaptInstructions(
  instructions: readonly Contribution<{ readonly file: string }>[],
  bodies: Readonly<Record<string, string>>,
  dest: string,
  problems: AdaptProblem[],
): AdaptedEntry | undefined {
  const [only] = instructions;
  if (only === undefined) return undefined;
  if (instructions.length === 1) {
    const source = only.component.file;
    return {
      kind: isAssetTreeReference(source) ? 'link' : 'copy',
      dest,
      source,
      from: [only.layer.reference],
    };
  }
  const parts: { reference: LayerReferenceText; body: string }[] = [];
  for (const { layer } of instructions) {
    const body = bodies[layer.name];
    if (body === undefined) {
      problems.push({
        kind: 'unread',
        reference: layer.reference,
        message: `instructions "${layer.name}" could not be read, so ${dest} cannot be put together`,
      });
      continue;
    }
    parts.push({ reference: layer.reference, body });
  }
  if (parts.length < instructions.length) return undefined;
  return {
    kind: 'generated',
    dest,
    content: concatenateInstructions(parts),
    from: parts.map(part => part.reference),
  };
}

// ── MCP servers ──────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a server reached at `url` speaks the older SSE transport rather than streamable HTTP. Read
 * from the path's last segment (`…/sse`), the convention every SSE server Ferretry has seen follows.
 */
export function isSseUrl(url: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/+$/, '');
  return pathname.split('/').at(-1)?.toLowerCase() === 'sse';
}

interface ServerEnvironment {
  /** Variables written as literal values. */
  readonly literal: Readonly<Record<string, string>>;
  /** Variables forwarded from the launch environment by name, because their value names a secret. */
  readonly forwarded: readonly string[];
}

const splitEnvironment = (env: Readonly<Record<string, string>>): ServerEnvironment => {
  const literal: Record<string, string> = {};
  const forwarded: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (secretReferencesIn(value).length > 0) forwarded.push(name);
    else literal[name] = value;
  }
  return { literal, forwarded };
};

/**
 * One server as Claude's `mcpServers` entry. A server signed in to from Ferretry carries its token as an
 * `Authorization` header that names a launch variable — Claude expands `${VAR}` in a server's headers
 * (INFERRED, docs/mcp-oauth.md) — so the document holds a variable name, never a value.
 */
function claudeServer(server: McpComponent, env: ServerEnvironment, bearer: string | undefined): SettingsObject {
  if (server.url !== undefined)
    return {
      type: isSseUrl(server.url) ? 'sse' : 'http',
      url: server.url,
      ...(bearer === undefined ? {} : { headers: { Authorization: `Bearer \${${bearer}}` } }),
    };
  const variables = { ...env.literal, ...Object.fromEntries(env.forwarded.map(name => [name, `\${${name}}`])) };
  return {
    type: 'stdio',
    command: server.command,
    args: server.args ?? [],
    ...(Object.keys(variables).length > 0 ? { env: variables } : {}),
  };
}

/** One server as Codex's `[mcp_servers.<name>]` table; a signed-in one names its token's variable. */
function codexServer(server: McpComponent, env: ServerEnvironment, bearer: string | undefined): SettingsObject {
  if (server.url !== undefined)
    return { url: server.url, ...(bearer === undefined ? {} : { bearer_token_env_var: bearer }) };
  return {
    command: server.command,
    ...(server.args !== undefined && server.args.length > 0 ? { args: server.args } : {}),
    ...(Object.keys(env.literal).length > 0 ? { env: env.literal } : {}),
    ...(env.forwarded.length > 0 ? { env_vars: env.forwarded } : {}),
  };
}

function adaptMcp(
  harness: HarnessKind,
  servers: readonly Contribution<McpComponent>[],
  launchEnv: Record<string, string>,
  problems: AdaptProblem[],
): Readonly<Record<string, SettingsObject>> {
  const owners = new Map<string, LayerReferenceText>();
  const reported = new Set<string>();
  const rendered: Record<string, SettingsObject> = {};
  for (const { layer, component } of servers) {
    const env = splitEnvironment(component.env ?? {});
    for (const variable of env.forwarded) {
      const value = (component.env as Record<string, string>)[variable] as string;
      const owner = owners.get(variable);
      if (owner !== undefined && launchEnv[variable] !== value) {
        if (!reported.has(variable)) {
          reported.add(variable);
          problems.push({
            kind: 'mcp-env-collision',
            variable,
            references: [owner, layer.reference],
            message: `MCP servers "${owner.slice(owner.indexOf('/') + 1)}" and "${layer.name}" both need ${variable} from a different secret, but a runtime has one ${variable}: rename it in one of them`,
          });
        }
        continue;
      }
      owners.set(variable, layer.reference);
      launchEnv[variable] = value;
    }
    // A server signed in to from Ferretry reads its access token from a launch variable bound to the
    // secret the daemon stored it under. The names have one owner, shared with the daemon.
    let bearer: string | undefined;
    if (component.auth === 'oauth') {
      const names = mcpOAuthSecretNames(layer.name);
      bearer = names.variable;
      launchEnv[bearer] = secretReference(names.access);
    }
    rendered[layer.name] =
      harness === 'claude' ? claudeServer(component, env, bearer) : codexServer(component, env, bearer);
  }
  return rendered;
}

// ── Hooks ────────────────────────────────────────────────────────────────────────────────────────

/** A hooks document's events. A document written as `{ "hooks": { … } }` is read as its inner block. */
const hookEvents = (body: SettingsObject): SettingsObject => {
  const keys = Object.keys(body);
  const inner = body.hooks;
  return keys.length === 1 && keys[0] === 'hooks' && isPlainObject(inner) ? inner : body;
};

/**
 * Hooks documents merged the way hooks merge (§3.4): all apply, in layer order, so each event's
 * handlers are the older layers' followed by the newer ones'.
 */
function mergeHooks(
  base: SettingsObject,
  contributions: readonly { readonly reference: LayerReferenceText; readonly body: SettingsObject }[],
  problems: AdaptProblem[],
): SettingsObject {
  const merged: Record<string, unknown> = { ...base };
  for (const { reference, body } of contributions) {
    for (const [event, handlers] of Object.entries(hookEvents(body))) {
      if (!Array.isArray(handlers)) {
        problems.push({
          kind: 'invalid-hooks',
          reference,
          event,
          message: `hooks "${reference.slice(reference.indexOf('/') + 1)}" gives ${event} something other than a list of hooks`,
        });
        continue;
      }
      const earlier = merged[event];
      merged[event] = [...(Array.isArray(earlier) ? earlier : []), ...handlers];
    }
  }
  return merged;
}

interface AdaptedHooks {
  readonly entries: readonly AdaptedEntry[];
  readonly absent: readonly string[];
  /** Claude only: the `hooks` block for `settings.json`, when any hooks document applies. */
  readonly settingsBlock?: SettingsObject;
}

function adaptHooks(
  harness: HarnessKind,
  hooks: ResolvedProfile['hooks'],
  bodies: Readonly<Record<string, SettingsObject>>,
  baseSettings: SettingsObject,
  assets: HarnessAssetTable,
  problems: AdaptProblem[],
): AdaptedHooks {
  const entries: AdaptedEntry[] = [];
  const absent: string[] = [];
  const files = hooks.filter(hook => hook.component.file !== undefined);
  const directories = hooks.filter(hook => hook.component.directory !== undefined);

  const scriptsDest = harnessAsset(assets, harness, 'hooksDir')?.dest ?? HOOK_SCRIPTS_FALLBACK_DEST;
  const newestDirectory = directories.at(-1);
  if (newestDirectory === undefined) absent.push(scriptsDest);
  else {
    if (directories.length > 1) {
      problems.push({
        kind: 'several-hook-directories',
        references: directories.map(hook => hook.layer.reference),
        message: `${directories.length} hooks components each bring a folder of hook scripts (${quoted(directories.map(hook => hook.layer.name))}), but a runtime has one hooks folder: put the scripts in one folder`,
      });
    }
    const source = newestDirectory.component.directory as string;
    entries.push({
      kind: isAssetTreeReference(source) ? 'link' : 'copy',
      dest: scriptsDest,
      source,
      from: [newestDirectory.layer.reference],
    });
  }

  const fileDest = hooksFileDest(assets, harness);
  // One hooks document with a file of its own is a link, so only a merge needs the bodies read.
  const needsBodies = fileDest === undefined || files.length > 1;
  const read: { reference: LayerReferenceText; body: SettingsObject }[] = [];
  for (const { layer } of needsBodies ? files : []) {
    const body = bodies[layer.name];
    if (body === undefined) {
      problems.push({
        kind: 'unread',
        reference: layer.reference,
        message: `hooks "${layer.name}" could not be read, so its hooks cannot be added`,
      });
      continue;
    }
    read.push({ reference: layer.reference, body });
  }

  if (fileDest === undefined) {
    // Claude: hooks are the `hooks` block of settings.json, after any a settings component set.
    if (files.length === 0) return { entries, absent };
    const base = isPlainObject(baseSettings.hooks) ? baseSettings.hooks : {};
    return { entries, absent, settingsBlock: mergeHooks(base, read, problems) };
  }

  const [onlyFile] = files;
  if (onlyFile === undefined) absent.push(fileDest);
  else if (files.length === 1) {
    const source = onlyFile.component.file as string;
    entries.push({
      kind: isAssetTreeReference(source) ? 'link' : 'copy',
      dest: fileDest,
      source,
      from: [onlyFile.layer.reference],
    });
  } else if (read.length === files.length) {
    entries.push({
      kind: 'generated',
      dest: fileDest,
      content: serializeSettings({ hooks: mergeHooks({}, read, problems) }, 'json'),
      from: read.map(part => part.reference),
    });
  }
  return { entries, absent };
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────

/** The person's own statusLine command, when their settings name one Claude would run. */
function ownStatuslineCommand(settings: SettingsObject): string | undefined {
  const statusLine = settings.statusLine;
  if (!isPlainObject(statusLine)) return undefined;
  const command = statusLine.command;
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

const plumbingFor = (plumbing: AdaptPlumbing, settings: SettingsObject): readonly PlumbingEntry[] => {
  if (plumbing.harness === 'claude') {
    return [
      { key: 'statusLine.type', path: ['statusLine', 'type'], value: 'command' },
      {
        key: 'statusLine.command',
        path: ['statusLine', 'command'],
        value: plumbing.statusLine(ownStatuslineCommand(settings)),
      },
    ];
  }
  return [
    { key: CODEX_CREDENTIAL_STORE_KEY, path: [CODEX_CREDENTIAL_STORE_KEY], value: CODEX_CREDENTIAL_STORE_FILE },
    { key: 'sqlite_home', path: ['sqlite_home'], value: plumbing.sqliteHome },
  ];
};

/** What `value`, written at `path`, holds at the deeper `at`; `undefined` when nothing. */
const valueBelow = (value: unknown, path: readonly string[], at: readonly string[]): unknown =>
  at.slice(path.length).reduce<unknown>((inner, segment) => (isPlainObject(inner) ? inner[segment] : undefined), value);

/**
 * The profile's settings leaves a write of `value` at `path` replaces. A leaf that already holds what
 * the write puts there is not replaced, and neither is an empty table the write merely fills.
 */
const replacedLeaves = (
  leaves: readonly SettingLeaf[],
  path: readonly string[],
  value: unknown,
): readonly SettingLeaf[] =>
  leaves.filter(leaf => {
    if (!pathsOverlap(leaf.path, path)) return false;
    if (leaf.path.length < path.length) return !(isPlainObject(leaf.value) && Object.keys(leaf.value).length === 0);
    return !sameSettingsValue(leaf.value, valueBelow(value, path, leaf.path));
  });

// ── Adapting a runtime ───────────────────────────────────────────────────────────────────────────

/**
 * Turn a profile resolved for one harness into that harness's files (§8.3). Total: a runtime that
 * cannot be written as asked comes back with {@link AdaptedRuntime.problems}.
 */
export function adaptProfile(input: AdaptInput): AdaptedRuntime {
  const { resolved, plumbing } = input;
  const assets = input.assets ?? HARNESS_ASSETS;
  const harness = resolved.harness;
  const problems: AdaptProblem[] = [];
  const overrides: AdaptOverride[] = [];
  const launchEnv: Record<string, string> = {};
  const settingsAsset = destOf(assets, harness, 'settings');
  const baseSettings = input.settings ?? resolved.settings.value;

  if (plumbing.harness !== harness) {
    problems.push({
      kind: 'harness-mismatch',
      message: `a ${HARNESS_DISPLAY_NAMES[harness]} runtime was given ${HARNESS_DISPLAY_NAMES[plumbing.harness]}'s plumbing`,
    });
  }

  const entries: AdaptedEntry[] = [];
  const absent: string[] = [];

  const instructionsDest = destOf(assets, harness, 'memory').dest;
  const instructions = adaptInstructions(
    resolved.instructions,
    input.bodies?.instructions ?? {},
    instructionsDest,
    problems,
  );
  if (instructions === undefined && resolved.instructions.length === 0) absent.push(instructionsDest);
  if (instructions !== undefined) entries.push(instructions);

  const skillsDest = destOf(assets, harness, 'skills').dest;
  const reserved = HARNESS_OWNED_SKILL_ENTRIES[harness];
  for (const { item, layer } of resolved.skills) {
    if (reserved.includes(item)) {
      problems.push({
        kind: 'reserved-skill-item',
        item,
        reference: layer.reference,
        message: `skill "${item}" has the name of the folder ${HARNESS_DISPLAY_NAMES[harness]} keeps its own skills in, so it cannot be added: rename it`,
      });
      continue;
    }
    entries.push({
      kind: 'link',
      dest: `${skillsDest}/${item}`,
      source: skillSourceReference(item),
      from: [layer.reference],
    });
  }

  const hooks = adaptHooks(harness, resolved.hooks, input.bodies?.hooks ?? {}, baseSettings, assets, problems);
  entries.push(...hooks.entries);
  absent.push(...hooks.absent);

  const servers = adaptMcp(harness, resolved.mcp, launchEnv, problems);

  let settings = baseSettings;
  let claudeJson: SettingsObject | undefined;
  if (harness === 'claude') {
    if (hooks.settingsBlock !== undefined) settings = { ...settings, hooks: hooks.settingsBlock };
    claudeJson = { mcpServers: servers };
  } else {
    for (const { layer } of resolved.mcp) {
      const path = ['mcp_servers', layer.name];
      for (const leaf of replacedLeaves(resolved.settings.leaves, path, servers[layer.name])) {
        overrides.push({ key: leaf.key, path: leaf.path, value: leaf.value, layer: leaf.layer, by: layer.reference });
      }
      const existing = isPlainObject(settings.mcp_servers) ? settings.mcp_servers : {};
      settings = { ...settings, mcp_servers: { ...existing, [layer.name]: servers[layer.name] } };
    }
  }

  // Another harness's plumbing would put its keys in the wrong document, so none is written.
  const plumbingEntries = plumbing.harness === harness ? plumbingFor(plumbing, baseSettings) : [];
  for (const entry of plumbingEntries) {
    // Claude's statusLine is chained, never replaced: the person's own command still runs.
    if (harness === 'codex') {
      for (const leaf of replacedLeaves(resolved.settings.leaves, entry.path, entry.value)) {
        overrides.push({ key: leaf.key, path: leaf.path, value: leaf.value, layer: leaf.layer, by: 'plumbing' });
      }
    }
    settings = deepMergeSettings(settings, nested(entry.path, entry.value));
  }

  return {
    harness,
    entries,
    absent,
    settings: { dest: settingsAsset.dest, format: settingsAsset.format as SettingsFormat, value: settings },
    ...(claudeJson === undefined ? {} : { claudeJson }),
    launchEnv,
    harnessOwned: reserved.map(entry => `${skillsDest}/${entry}`),
    plumbing: plumbingEntries,
    overrides,
    problems,
  };
}

// ── Partial support (K5, E22) ────────────────────────────────────────────────────────────────────

/**
 * Claude skill frontmatter keys Codex does not honour, and what that means, in the product's words.
 * INFERRED from Codex's skill loader, which reads a skill's name, description and metadata only.
 */
export const CODEX_IGNORED_SKILL_KEYS: Readonly<Record<string, (item: string) => string>> = {
  'allowed-tools': item => `${item} limits which tools it may use. Codex ignores that limit and loads the rest.`,
  model: item => `${item} picks its own model. Codex ignores that and uses the runtime's model.`,
  hooks: item => `${item} carries its own hooks. Codex ignores them and loads the rest.`,
};

/**
 * The top-level keys of a skill's `SKILL.md` frontmatter, in order. Text with no frontmatter has
 * none. Keys only, never values, so nothing a skill says is carried further than its shape.
 */
export function skillFrontmatterKeys(text: string): readonly string[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];
  const keys: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return keys;
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match !== null && !keys.includes(match[1] as string)) keys.push(match[1] as string);
  }
  // An unterminated block is not frontmatter, so it declares nothing.
  return [];
}

/** A line of a Claude instructions file that pulls in another file: `@path/to/file.md`. */
const CLAUDE_IMPORT_LINE = /^\s*@[^\s@]+\s*$/m;

/** Whether an instructions body pulls in other files the way Claude's `@path` imports do. */
export const usesClaudeImports = (body: string): boolean => CLAUDE_IMPORT_LINE.test(body);

/** The facts partial support is decided from, read by the caller. */
export interface PartialSupportFacts {
  readonly components: Pick<Components, 'instructions' | 'mcp' | 'skills'>;
  /** Each skill item's frontmatter keys ({@link skillFrontmatterKeys}), by item name. */
  readonly skillFrontmatter?: Readonly<Record<string, readonly string[]>>;
  /** Instructions text, by component name. */
  readonly instructionBodies?: Readonly<Record<string, string>>;
}

/**
 * The declared partial-support table (K5, E22), evaluated over a machine's generic components. The
 * result is what `resolveProfile` takes as `partialSupport`. A component narrowed to one harness can
 * only be partial on that harness, and Claude honours everything these components can say, so every
 * entry today is about Codex.
 */
export function componentPartialSupport(facts: PartialSupportFacts): readonly PartialSupport[] {
  const entries: PartialSupport[] = [];
  const reachesCodex = (component: { readonly harness?: HarnessKind }) => component.harness !== 'claude';

  for (const [name, component] of Object.entries(facts.components.instructions)) {
    const body = facts.instructionBodies?.[name];
    if (!reachesCodex(component) || body === undefined || !usesClaudeImports(body)) continue;
    entries.push({
      reference: `instructions/${name}`,
      harness: 'codex',
      reason: `${name} pulls in other files with @path lines. Codex reads those lines as plain text and does not open the files.`,
    });
  }

  for (const [name, component] of Object.entries(facts.components.mcp)) {
    if (!reachesCodex(component) || component.url === undefined || !isSseUrl(component.url)) continue;
    entries.push({
      reference: `mcp/${name}`,
      harness: 'codex',
      reason: `${name} is reached over SSE. Codex connects to servers over streamable HTTP, so it may not reach this one.`,
    });
  }

  for (const [name, component] of Object.entries(facts.components.skills)) {
    if (!reachesCodex(component)) continue;
    for (const item of component.items) {
      for (const key of facts.skillFrontmatter?.[item] ?? []) {
        const reason = CODEX_IGNORED_SKILL_KEYS[key];
        if (reason !== undefined) entries.push({ reference: `skills/${name}`, harness: 'codex', reason: reason(item) });
      }
    }
  }
  return entries;
}

/** A partial-support entry in the product's words (E22): "Partly supported on Codex: …". */
export const describePartialSupport = (entry: PartialSupport): string =>
  `Partly supported on ${HARNESS_DISPLAY_NAMES[entry.harness]}: ${entry.reason}`;

/** The badge a profile or component carries on `harness` when any of it is partial there (E14). */
export const partialSupportBadge = (partial: readonly PartialSupport[], harness: HarnessKind): string | undefined =>
  partial.some(entry => entry.harness === harness)
    ? `Partly supported on ${HARNESS_DISPLAY_NAMES[harness]}`
    : undefined;
