/**
 * The first-run import, and "Import again" (docs/design/account-model.md §4.3, E3–E10, §9.7).
 *
 * A machine that already runs Claude Code or Codex has a setup: a login, an instructions document,
 * settings, MCP servers, skills and hooks. This module turns what the host scan read
 * (`../../adapters/host-harness-scan.ts`) into the account model's words — one credential per harness
 * kept `store: host`, one component per thing found, and a **Default** profile PER HARNESS that layers
 * the generic parts and that harness's own (`claude-default`, `codex-default`) — so the person's own setup
 * is what their first runtimes run, and no profile is both Claude only and Codex only (P7).
 *
 * THE RULES IT APPLIES, each one the design's:
 *
 * - **The login is shared in place, never copied (C1, C3).** A credential here is a pointer: `store:
 *   host`. The one exception is a Codex host that keeps its login in a keyring (gap G5): there is no
 *   file to link, so the credential is an empty `store: ferretry` slot that needs sign-in.
 * - **Not signed in still imports (E4).** The credential lands, the components land, and the preview
 *   says sign-in comes later. A login that needs a refresh imports too (E6): the harness renews it.
 * - **Nothing found is a plain Starter profile (E5)** per harness, holding only its model set.
 * - **Secret-looking values never sit in a component (E7, K4).** They are moved into
 *   {@link ImportPlan.secrets} — the only field anywhere in this module that carries a value — and
 *   the component holds a `${secret:NAME}` reference. The preview names the keys and nothing else.
 * - **A missing MCP command is a warning, not a refusal (E8, K6).**
 * - **Identical `CLAUDE.md` and `AGENTS.md` are ONE generic Instructions component; different ones
 *   are two, each narrowed to its harness (E9, K3).** Skills and MCP servers follow the same rule by
 *   name.
 * - **First-run runtimes are agent runtimes (owner default O2).** Running agents is what Ferretry is
 *   for; the person's own `claude` / `codex` stays their own CLI.
 * - **Import again adds only what is new, and OFFERS — never applies — an update to a component
 *   whose source changed since the last import (owner default O6).** The {@link ImportRecord} is how
 *   it knows which components an import made and what their source said then.
 *
 * Pure: documents in, a plan out. Reading the host is the adapter's; writing the plan is the setup
 * executor's. A content digest is a caller-supplied function, because hashing is not this layer's.
 */
import { MIN_SECRET_VALUE_LENGTH, secretReference, secretReferencesIn } from '@ferretry/protocol';
import { isUsableSkillItemName } from '../assets.ts';
import { RESERVED_ENV_NAMES } from '../config.ts';
import { FLEET_STARTER_MODELS } from '../defaults.ts';
import type { HarnessKind } from '../manifest.ts';
import { parseSettings, type SettingsFormat, type SettingsObject, serializeSettings } from '../settings.ts';
import { HARNESS_DISPLAY_NAMES, modelHarness } from './layering.ts';
import { componentScope, scopeFits } from './scope.ts';
import {
  type AccountModel,
  type AccountModelDocument,
  type ComponentKind,
  type Credential,
  type HooksComponent,
  type InstructionsComponent,
  isRuntimeName,
  type LayeredProfile,
  type LayerReferenceText,
  type McpComponent,
  type ModelSetComponent,
  parseAccountModel,
  parseLayerReference,
  type Runtime,
  type SettingsComponent,
  type SkillsComponent,
} from './schema.ts';

// ── What the host scan hands in ──────────────────────────────────────────────────────────────────

/**
 * The person's own login for one harness, as the scan classified it. Never the credential itself.
 *
 * - `signed-in` — a credential is there and its access token has not expired.
 * - `refresh-due` — the access token expired and a refresh token is there; the harness renews it.
 * - `not-signed-in` — there is no login to share.
 * - `unreadable` — something is there that could not be read (a locked keychain, a damaged file).
 * - `not-shareable` — a login may exist but cannot be shared in place (Codex on a keyring, G5).
 */
export type HostLoginState = 'signed-in' | 'refresh-due' | 'not-signed-in' | 'unreadable' | 'not-shareable';

export interface HostLogin {
  readonly state: HostLoginState;
  /** The account's email, when the harness records one. Display only. */
  readonly email?: string;
  /** Why, for `unreadable` and `not-shareable`. */
  readonly reason?: string;
}

/** One read of one host document, classified rather than thrown. `source` is the absolute path. */
export type HostDocumentRead =
  | { readonly kind: 'text'; readonly source: string; readonly text: string; readonly bytes: number }
  | { readonly kind: 'absent'; readonly source: string }
  | { readonly kind: 'too-large'; readonly source: string; readonly bytes: number }
  | { readonly kind: 'unreadable'; readonly source: string; readonly reason: string };

/** One skill folder found on the host. `digest` covers the folder's whole content. */
export interface HostSkill {
  readonly item: string;
  /** The folder, absolute. */
  readonly source: string;
  readonly digest: string;
}

/** Everything the scan read for one harness. */
export interface HostHarnessScan {
  readonly harness: HarnessKind;
  /** The located command, absent when the harness is not installed here (E3). */
  readonly command?: string;
  readonly login: HostLogin;
  /** `CLAUDE.md` / `AGENTS.md`. */
  readonly instructions: HostDocumentRead;
  /** `settings.json` / `config.toml`. Codex's MCP servers are read out of it. */
  readonly settings: HostDocumentRead;
  /** Claude only: `~/.claude.json`, where Claude keeps its user-scope MCP servers. */
  readonly mcp?: HostDocumentRead;
  /** Codex only: `hooks.json`. Claude's hooks are the `hooks` block of its settings. */
  readonly hooks?: HostDocumentRead;
  readonly skills: readonly HostSkill[];
  /** MCP commands that resolve to nothing on this machine (E8), by command name. */
  readonly missingCommands: readonly string[];
  /** Sentences for anything the scan could not read that is not one of the documents above. */
  readonly problems: readonly string[];
}

/** The format each harness writes its settings in. */
export const HOST_SETTINGS_FORMAT: Readonly<Record<HarnessKind, SettingsFormat>> = {
  claude: 'json',
  codex: 'toml',
};

/** What each harness calls its instructions document. */
export const HOST_INSTRUCTIONS_NAME: Readonly<Record<HarnessKind, string>> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
};

// ── What comes out ───────────────────────────────────────────────────────────────────────────────

/** A file the setup executor writes into the asset tree, relative to `<FY_HOME>/fleet/assets`. */
export type ImportFile =
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  /** A whole folder copied from the host (a skill). `from` is absolute. */
  | { readonly kind: 'copy-directory'; readonly path: string; readonly from: string };

/**
 * One value moved into Ferretry's secret store. THE ONLY place a value travels; it is never in a
 * preview, a note, a warning, a record or a component.
 */
export interface ImportedSecret {
  readonly name: string;
  readonly value: string;
  /** Where it was found, as `<reference> · <key>` — names only. */
  readonly from: string;
}

/** A sentence about one harness's import, for the result screen (E4–E9). */
export interface ImportNote {
  readonly harness: HarnessKind;
  readonly text: string;
}

/** What one import made a component from, so Import again can tell whether its source changed. */
export interface ImportRecordEntry {
  readonly sources: readonly string[];
  readonly digest: string;
}

/**
 * What the imports so far created, persisted by the setup executor after a successful apply. Only a
 * component an import made is ever offered an update; one the person made is theirs.
 */
export interface ImportRecord {
  readonly version: 1;
  readonly components: Readonly<Record<string, ImportRecordEntry>>;
  /**
   * The ONE profile an import made before P7, shared by both harnesses, which later imports still
   * extend. A record written since names {@link ImportRecord.profiles} instead.
   */
  readonly profile?: string;
  /** The profile an import made for each harness, which later imports extend with what is new. */
  readonly profiles?: Readonly<Partial<Record<HarnessKind, string>>>;
}

export const EMPTY_IMPORT_RECORD: ImportRecord = { version: 1, components: {} };

/** One component whose source changed since the last import (O6). Offered, never applied. */
export interface ImportUpdate {
  readonly reference: LayerReferenceText;
  readonly sources: readonly string[];
  /** The component as the source says now, and the files it needs. */
  readonly component: ImportedComponent;
  readonly files: readonly ImportFile[];
  readonly secrets: readonly ImportedSecret[];
  readonly digest: string;
}

/** A runtime the import did not create because one already uses that login and profile (E15). */
export interface ImportDuplicate {
  readonly harness: HarnessKind;
  readonly existing: string;
  /** The name it would have had, so "Add another anyway" can create it. */
  readonly suggested: string;
}

/** One component of any kind, as the plan carries it. */
export type ImportedComponent =
  | { readonly kind: 'instructions'; readonly name: string; readonly value: InstructionsComponent }
  | { readonly kind: 'mcp'; readonly name: string; readonly value: McpComponent }
  | { readonly kind: 'skills'; readonly name: string; readonly value: SkillsComponent }
  | { readonly kind: 'settings'; readonly name: string; readonly value: SettingsComponent }
  | { readonly kind: 'hooks'; readonly name: string; readonly value: HooksComponent }
  | { readonly kind: 'modelSets'; readonly name: string; readonly value: ModelSetComponent };

/** The value-free preview the scan route serves (§7 `/v1/fleet/setup/scan`). */
export interface HarnessImportPreview {
  readonly harness: HarnessKind;
  readonly installed: boolean;
  readonly account: HostLogin;
  readonly instructions?: { readonly name: string; readonly source: string; readonly bytes: number };
  /** Settings found: how many, and how many hooks rode in them. */
  readonly settings?: { readonly source: string; readonly count: number; readonly hooks: number };
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  /** Secret-looking keys, by NAME only (`env.ANTHROPIC_API_KEY`). */
  readonly secretKeys: readonly string[];
  readonly missingCommands: readonly string[];
  /** Sentences for anything that could not be read or imported. */
  readonly problems: readonly string[];
}

export interface ImportPreview {
  readonly harnesses: readonly HarnessImportPreview[];
  /**
   * Whether `CLAUDE.md` and `AGENTS.md` say the same thing: `undefined` unless both were found.
   * "Same as your CLAUDE.md · one shared copy" / "Different from your CLAUDE.md · kept separately".
   */
  readonly instructionsIdentical?: boolean;
}

/** Everything an import adds. Merge it with {@link mergeImport}. */
export interface ImportPlan {
  readonly preview: ImportPreview;
  /** The harnesses actually imported, in order. */
  readonly imported: readonly HarnessKind[];
  readonly credentials: Readonly<Record<string, Credential>>;
  readonly components: readonly ImportedComponent[];
  /** New profiles, and an import-made profile extended with the new layers. */
  readonly profiles: Readonly<Record<string, LayeredProfile>>;
  readonly runtimes: Readonly<Record<string, Runtime>>;
  readonly files: readonly ImportFile[];
  readonly secrets: readonly ImportedSecret[];
  /** Per-component warnings that do not block saving (K6), keyed by layer reference. */
  readonly warnings: Readonly<Record<string, readonly string[]>>;
  readonly notes: readonly ImportNote[];
  readonly updates: readonly ImportUpdate[];
  readonly duplicates: readonly ImportDuplicate[];
  /** The record to persist once this plan has been applied. */
  readonly record: ImportRecord;
}

export interface ImportOptions {
  /** The harnesses the person chose to import. Default: every installed one. */
  readonly include?: readonly HarnessKind[];
  /** The machine's current configuration, for Import again. */
  readonly existing?: AccountModel;
  readonly record?: ImportRecord;
  /** Secret names already in the store, so an import never overwrites one. */
  readonly existingSecrets?: readonly string[];
  /** Harnesses whose duplicate runtime should be created anyway ("Add another anyway"). */
  readonly addDuplicates?: readonly HarnessKind[];
  /** A content digest. Equal inputs give equal outputs; that is all that is asked of it. */
  readonly digest: (text: string) => string;
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The names an import gives what it makes. */
export const IMPORT_NAMES = {
  /** One generic instructions component, when `CLAUDE.md` and `AGENTS.md` match (E9). */
  sharedInstructions: 'main',
  /** The profile that matches the person's setup. */
  defaultProfile: 'default',
  /** The profile a machine with nothing to import gets (E5). */
  starterProfile: 'starter',
  /** The generic skills component, for items both harnesses hold identically. */
  sharedSkills: 'skills',
} as const;

const harnessNamed = (harness: HarnessKind, what: string): string => `${harness}-${what}`;

/**
 * The runtime an import makes for one harness on one profile — `claude-default` on a machine whose
 * setup was found, before any `-2` a clash adds. Exported because help text names it as the example,
 * and an example spelled by hand drifted to a name no import ever created.
 */
export const importedRuntimeName = (harness: HarnessKind, profile: string): string => harnessNamed(harness, profile);

/** The asset-tree path of a component's file (§5.3). */
export const componentFilePath = (kind: ComponentKind, name: string, extension: string): string =>
  `components/${kind}/${name}.${extension}`;

/** Where a skill item lives in the asset tree's skills store. */
const skillStorePath = (item: string): string => `skills/${item}`;

/** `name`, or `name-2`, `name-3`… — the first that `taken` does not hold. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name}-${String(index)}`;
    if (!taken(candidate)) return candidate;
  }
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────────

/** Name words that say a variable holds a credential. Matched per `_`-separated word. */
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'AUTHORIZATION',
  'COOKIE',
  'PAT',
]);

/** Name word pairs that say the same: `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `SECRET_KEY`. */
const SECRET_NAME_PAIRS: ReadonlySet<string> = new Set(['API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SECRET_KEY']);

const TOKEN_BODY = '[A-Za-z0-9_-]{8,}';

/**
 * THE list of well-known token formats (one owner): each is a fixed prefix and the body that follows it. A
 * value that starts with a prefix is a secret by value ({@link looksSecret}), and text that holds a whole token
 * anywhere, glued to anything, is cut ({@link SECRET_TOKEN_SOURCE}). Every body is a linear class of a minimum
 * length and no format looks behind it: `<&ghp_x` and `{sk-x` are cut as `ghp_x` and `sk-x` are. A new format
 * is added here and nowhere else.
 */
const TOKEN_FORMATS: readonly (readonly [prefix: string, body: string])[] = [
  ['sk-', TOKEN_BODY],
  ['sk_live_', TOKEN_BODY],
  ['gh[pousr]_', TOKEN_BODY],
  ['github_pat_', TOKEN_BODY],
  ['glpat-', TOKEN_BODY],
  ['xox[abposr]-', TOKEN_BODY],
  ['(?:AKIA|ASIA)', '[A-Z0-9]{16}'],
  ['AIza', TOKEN_BODY],
  ['npm_', TOKEN_BODY],
  ['hf_', TOKEN_BODY],
];

/** Value prefixes of well-known token formats, and of two more whose body is not a plain run (a Google OAuth token, a JWT). */
const SECRET_VALUE_PREFIX = new RegExp(`^(?:${TOKEN_FORMATS.map(([prefix]) => prefix).join('|')}|ya29\\.|eyJ)`, 'u');

/** The regular expression source of any whole token in a text; a caller builds it with the `g` and `u` flags. */
export const SECRET_TOKEN_SOURCE: string = TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`).join('|');

/** A value that only points somewhere else: `$NAME`, `${NAME}`, `${secret:NAME}`. */
const INDIRECT_VALUE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/u;

/**
 * Whether one environment entry looks like a secret (E7).
 *
 * By NAME (a word such as `TOKEN` or `API_KEY`) or by VALUE (a well-known token prefix). A value
 * that is only a reference to another variable is not a secret, because it holds none, and a value
 * shorter than the secret store accepts is a flag rather than a credential (`AUTH=1`).
 */
export function looksSecret(name: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH || INDIRECT_VALUE.test(value)) return false;
  if (secretReferencesIn(value).length > 0) return false;
  if (SECRET_VALUE_PREFIX.test(value)) return true;
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  if (words.some(word => SECRET_NAME_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}

/** A secret name in the store's grammar, from an environment variable name. */
const secretNameOf = (variable: string): string => {
  const upper = variable.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  const named = /^[A-Z]/u.test(upper) ? upper : `S_${upper}`;
  return named.slice(0, 64);
};

/** Hands out secret names, once per value, never one the store already holds. */
class SecretNames {
  readonly #taken: Set<string>;
  readonly #byName = new Map<string, string>();

  constructor(existing: readonly string[]) {
    this.#taken = new Set(existing);
  }

  /** The secret for `value` under a name derived from `variable`, reusing it for an equal value. */
  claim(variable: string, value: string, from: string, secrets: ImportedSecret[]): string {
    const base = secretNameOf(variable);
    for (const [name, held] of this.#byName) {
      if (held === value && (name === base || name.startsWith(`${base}_`))) return name;
    }
    const free = (candidate: string): boolean => !this.#taken.has(candidate) && !this.#byName.has(candidate);
    let name = base;
    for (let index = 2; !free(name); index += 1) name = `${base.slice(0, 60)}_${String(index)}`;
    this.#byName.set(name, value);
    secrets.push({ name, value, from });
    return name;
  }
}

interface EnvImport {
  readonly env: Record<string, string>;
  readonly secretKeys: string[];
  readonly dropped: string[];
}

/** An environment block with every secret-looking value replaced by a reference. */
function importEnv(
  env: unknown,
  keyPrefix: string,
  from: string,
  names: SecretNames,
  secrets: ImportedSecret[],
): EnvImport {
  const result: EnvImport = { env: {}, secretKeys: [], dropped: [] };
  if (!isRecord(env)) return result;
  for (const [variable, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      result.dropped.push(`${keyPrefix}${variable} (not a text value)`);
      continue;
    }
    const value = String(raw);
    if ((RESERVED_ENV_NAMES as readonly string[]).includes(variable)) {
      result.dropped.push(`${keyPrefix}${variable} (Ferretry sets it for each runtime)`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
      result.dropped.push(`${keyPrefix}${variable} (not an environment variable name)`);
      continue;
    }
    if (looksSecret(variable, value)) {
      result.secretKeys.push(`${keyPrefix}${variable}`);
      result.env[variable] = secretReference(
        names.claim(variable, value, `${from} · ${keyPrefix}${variable}`, secrets),
      );
      continue;
    }
    if (/\$\{secret:/u.test(value) && secretReferencesIn(value).length === 0) {
      result.dropped.push(`${keyPrefix}${variable} (a malformed secret reference)`);
      continue;
    }
    result.env[variable] = value;
  }
  return result;
}

// ── Reading documents ────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why a document could not be used, or `undefined` when it is simply absent or was read. */
function unreadableReason(read: HostDocumentRead, what: string): string | undefined {
  if (read.kind === 'too-large') return `${what} at ${read.source} is ${String(read.bytes)} bytes, too large to import`;
  if (read.kind === 'unreadable') return `${what} at ${read.source} could not be read (${read.reason})`;
  return undefined;
}

/** A settings-shaped document, parsed; `undefined` when absent, with a problem when it is broken. */
function parsedDocument(
  read: HostDocumentRead | undefined,
  format: SettingsFormat,
  what: string,
  problems: string[],
): SettingsObject | undefined {
  if (read === undefined || read.kind === 'absent') return undefined;
  const reason = unreadableReason(read, what);
  if (reason !== undefined || read.kind !== 'text') {
    problems.push(reason as string);
    return undefined;
  }
  if (read.text.trim() === '') return {};
  try {
    return parseSettings(read.text, format);
  } catch (error) {
    problems.push(`${what} at ${read.source} is not valid ${format} (${errorText(error)}), so it was not imported`);
    return undefined;
  }
}

// ── Models ───────────────────────────────────────────────────────────────────────────────────────

/** An environment name that names a model: one ending in `MODEL`, in either harness's spelling. */
const MODEL_ENV_NAME = /(^|_)MODEL$/u;

/**
 * Every model id a harness's settings name, in preference order without repeats: its own `model`
 * first, then each `env` entry whose name ends in `MODEL`, then each named profile's `model`.
 *
 * The ONE owner of this rule; the account form's discovery (`harness-discovery.ts`) reads it too.
 */
export function declaredModelIds(settings: SettingsObject): readonly string[] {
  const found: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const model = value.trim();
    if (model !== '' && !found.includes(model)) found.push(model);
  };
  add(settings.model);
  const env = settings.env;
  if (isRecord(env)) for (const [name, value] of Object.entries(env)) if (MODEL_ENV_NAME.test(name)) add(value);
  const profiles = settings.profiles;
  if (isRecord(profiles)) for (const profile of Object.values(profiles)) if (isRecord(profile)) add(profile.model);
  return found;
}

/** The model set a harness's settings imply: the models it names for that harness, or the starter. */
function modelSetOf(harness: HarnessKind, settings: SettingsObject | undefined): ModelSetComponent {
  const named = declaredModelIds(settings ?? {}).filter(id => modelHarness(id) === harness);
  const [first] = named;
  if (first === undefined) return { models: [FLEET_STARTER_MODELS[harness]], default: FLEET_STARTER_MODELS[harness] };
  return { models: [...named], default: first };
}

// ── MCP servers ──────────────────────────────────────────────────────────────────────────────────

/** One MCP server as the host declared it, before secrets are moved. */
export interface ScannedMcpServer {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, unknown>>;
  readonly url?: string;
  /** Keys the host's declaration has that a component cannot carry (`headers`, `bearer_token_env_var`). */
  readonly ignored: readonly string[];
}

const CLAUDE_MCP_KEYS: ReadonlySet<string> = new Set(['type', 'command', 'args', 'env', 'url']);
const CODEX_MCP_KEYS: ReadonlySet<string> = new Set(['command', 'args', 'env', 'url', 'enabled']);

/** Where each harness's MCP servers sit: Claude's `mcpServers` in `.claude.json`, Codex's `mcp_servers`. */
const mcpTableOf = (harness: HarnessKind, document: SettingsObject | undefined): SettingsObject => {
  const table = document?.[harness === 'claude' ? 'mcpServers' : 'mcp_servers'];
  return isRecord(table) ? table : {};
};

function scannedServer(harness: HarnessKind, name: string, entry: unknown): ScannedMcpServer | undefined {
  if (!isRecord(entry)) return undefined;
  if (harness === 'codex' && entry.enabled === false) return undefined;
  const known = harness === 'claude' ? CLAUDE_MCP_KEYS : CODEX_MCP_KEYS;
  const command = typeof entry.command === 'string' && entry.command.trim() !== '' ? entry.command : undefined;
  const url = typeof entry.url === 'string' && entry.url.trim() !== '' ? entry.url : undefined;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
  return {
    name,
    ...(command === undefined ? {} : { command }),
    ...(command !== undefined && args.length > 0 ? { args } : {}),
    ...(command !== undefined && isRecord(entry.env) ? { env: entry.env } : {}),
    ...(command === undefined && url !== undefined ? { url } : {}),
    ignored: Object.keys(entry).filter(key => !known.has(key)),
  };
}

/**
 * The MCP servers one harness's scan declares. Exported so the scan adapter can look up each
 * server's command on this machine before the plan is made (E8).
 */
export function scannedMcpServers(scan: HostHarnessScan): readonly ScannedMcpServer[] {
  const problems: string[] = [];
  const document =
    scan.harness === 'claude'
      ? parsedDocument(scan.mcp, 'json', '.claude.json', problems)
      : parsedDocument(scan.settings, 'toml', 'config.toml', problems);
  return Object.entries(mcpTableOf(scan.harness, document)).flatMap(([name, entry]) => {
    const server = scannedServer(scan.harness, name, entry);
    return server === undefined ? [] : [server];
  });
}

// ── One harness, read into components ────────────────────────────────────────────────────────────

/** What one harness's scan turned into, before the two harnesses are reconciled. */
interface HarnessHarvest {
  readonly harness: HarnessKind;
  readonly instructions?: { readonly text: string; readonly source: string };
  readonly settings?: {
    readonly value: SettingsComponent;
    readonly content?: string;
    readonly source: string;
    readonly count: number;
  };
  readonly hooks?: { readonly content: string; readonly source: string; readonly count: number };
  readonly mcp: readonly {
    readonly name: string;
    readonly value: McpComponent;
    readonly source: string;
    readonly warnings: readonly string[];
  }[];
  readonly skills: readonly HostSkill[];
  readonly modelSet: ModelSetComponent;
  readonly secretKeys: readonly string[];
  readonly problems: readonly string[];
  /** Whether anything at all was found, which decides Default or Starter (E5). */
  readonly found: boolean;
}

/** Codex keys a runtime's plumbing sets itself (§8.3), dropped from an imported settings file. */
const CODEX_PLUMBING_KEYS = ['cli_auth_credentials_store', 'sqlite_home'] as const;

/** How many hook handlers a hooks block carries, for "6 settings, 1 hook". */
const countHooks = (block: Readonly<Record<string, unknown>>): number =>
  Object.values(block).reduce<number>(
    (total, handlers) =>
      total +
      (Array.isArray(handlers)
        ? handlers.reduce<number>(
            (inner, handler) => inner + (isRecord(handler) && Array.isArray(handler.hooks) ? handler.hooks.length : 1),
            0,
          )
        : 0),
    0,
  );

function harvest(scan: HostHarnessScan, names: SecretNames, secrets: ImportedSecret[]): HarnessHarvest {
  const { harness } = scan;
  const problems: string[] = [...scan.problems];
  const secretKeys: string[] = [];
  const format = HOST_SETTINGS_FORMAT[harness];
  const settingsFile = harness === 'claude' ? 'settings.json' : 'config.toml';

  // Instructions.
  const instructionsName = HOST_INSTRUCTIONS_NAME[harness];
  const instructionsProblem = unreadableReason(scan.instructions, instructionsName);
  if (instructionsProblem !== undefined) problems.push(instructionsProblem);
  const instructions =
    scan.instructions.kind === 'text' && scan.instructions.text.trim() !== ''
      ? { text: scan.instructions.text, source: scan.instructions.source }
      : undefined;

  // Settings, with the parts that become their own components taken out.
  const parsed = parsedDocument(scan.settings, format, settingsFile, problems);
  const rest: Record<string, unknown> = { ...(parsed ?? {}) };
  let hooks: HarnessHarvest['hooks'];
  let envImport: EnvImport | undefined;
  if (harness === 'claude') {
    if (isRecord(rest.hooks) && Object.keys(rest.hooks).length > 0) {
      hooks = {
        content: serializeSettings({ hooks: rest.hooks }, 'json'),
        source: scan.settings.source,
        count: countHooks(rest.hooks),
      };
    }
    delete rest.hooks;
    envImport = importEnv(rest.env, 'env.', settingsFile, names, secrets);
    delete rest.env;
  } else {
    delete rest.mcp_servers;
    for (const key of CODEX_PLUMBING_KEYS) delete rest[key];
    const policy = rest.shell_environment_policy;
    if (isRecord(policy) && isRecord(policy.set)) {
      envImport = importEnv(policy.set, 'shell_environment_policy.set.', settingsFile, names, secrets);
      const kept = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'set'));
      if (Object.keys(kept).length === 0) delete rest.shell_environment_policy;
      else rest.shell_environment_policy = kept;
    }
    const hooksDocument = parsedDocument(scan.hooks, 'json', 'hooks.json', problems);
    if (hooksDocument !== undefined && Object.keys(hooksDocument).length > 0 && scan.hooks !== undefined) {
      hooks = {
        content: serializeSettings(hooksDocument, 'json'),
        source: scan.hooks.source,
        count: countHooks(isRecord(hooksDocument.hooks) ? hooksDocument.hooks : hooksDocument),
      };
    }
  }
  if (envImport !== undefined) {
    secretKeys.push(...envImport.secretKeys);
    if (envImport.dropped.length > 0) {
      problems.push(`Left out of your ${settingsFile}: ${envImport.dropped.join(', ')}.`);
    }
  }
  const env = envImport?.env ?? {};
  const hasRest = Object.keys(rest).length > 0;
  const hasEnv = Object.keys(env).length > 0;
  const settings: HarnessHarvest['settings'] =
    hasRest || hasEnv
      ? {
          value: {
            harness,
            ...(hasRest ? { file: componentFilePath('settings', harnessNamed(harness, 'settings'), format) } : {}),
            ...(hasEnv ? { env } : {}),
          },
          ...(hasRest ? { content: serializeSettings(rest, format) } : {}),
          source: scan.settings.source,
          count: Object.keys(rest).length + Object.keys(env).length,
        }
      : undefined;

  // MCP servers.
  const missing = new Set(scan.missingCommands);
  const mcpSource = harness === 'claude' ? (scan.mcp?.source ?? '.claude.json') : scan.settings.source;
  const mcp = scannedMcpServers(scan).flatMap(server => {
    const warnings: string[] = [];
    if (server.ignored.length > 0) {
      warnings.push(
        `Not imported from your ${server.name} server: ${server.ignored.join(', ')}. Add it again yourself.`,
      );
    }
    if (server.command === undefined && server.url === undefined) {
      problems.push(`MCP server "${server.name}" names neither a command nor a url, so it was not imported.`);
      return [];
    }
    if (server.url !== undefined && !URL.canParse(server.url)) {
      problems.push(`MCP server "${server.name}" has a url that is not a web address, so it was not imported.`);
      return [];
    }
    const serverEnv =
      server.env === undefined
        ? undefined
        : importEnv(server.env, `${server.name}.env.`, `${harness} MCP server ${server.name}`, names, secrets);
    if (serverEnv !== undefined) {
      secretKeys.push(...serverEnv.secretKeys.map(key => `mcp.${key}`));
      if (serverEnv.dropped.length > 0) warnings.push(`Left out: ${serverEnv.dropped.join(', ')}.`);
    }
    if (server.command !== undefined && missing.has(server.command)) {
      warnings.push(
        `Command not found: ${server.command}. Install it on this machine; the server starts working once it is there.`,
      );
    }
    const value: McpComponent =
      server.command !== undefined
        ? {
            command: server.command,
            ...(server.args === undefined ? {} : { args: [...server.args] }),
            ...(serverEnv !== undefined && Object.keys(serverEnv.env).length > 0 ? { env: serverEnv.env } : {}),
          }
        : { url: server.url as string };
    return [{ name: server.name, value, source: mcpSource, warnings }];
  });

  const skills = scan.skills.filter(skill => {
    if (isUsableSkillItemName(skill.item)) return true;
    problems.push(`Skill "${skill.item}" has a folder name Ferretry cannot use, so it was not imported.`);
    return false;
  });

  return {
    harness,
    ...(instructions === undefined ? {} : { instructions }),
    ...(settings === undefined ? {} : { settings }),
    ...(hooks === undefined ? {} : { hooks }),
    mcp,
    skills,
    modelSet: modelSetOf(harness, parsed),
    secretKeys,
    problems,
    found:
      instructions !== undefined ||
      settings !== undefined ||
      hooks !== undefined ||
      mcp.length > 0 ||
      skills.length > 0,
  };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────

/** One component the import wants, before Import again decides whether it is new. */
interface Candidate {
  readonly component: ImportedComponent;
  readonly files: readonly ImportFile[];
  readonly sources: readonly string[];
  /** Over the component and its file content, so a changed source is a changed digest. */
  readonly digestText: string;
  readonly warnings: readonly string[];
}

const referenceOf = (kind: ComponentKind, name: string): LayerReferenceText => `${kind}/${name}`;

const sameText = (left: string, right: string): boolean =>
  left.replace(/\r\n/gu, '\n').trimEnd() === right.replace(/\r\n/gu, '\n').trimEnd();

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** The layer order a Default profile reads in, as §5.2 shows it. */
const LAYER_ORDER: readonly ComponentKind[] = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'];

function instructionsCandidates(harvests: readonly HarnessHarvest[]): {
  candidates: Candidate[];
  identical?: boolean;
} {
  const found = harvests.flatMap(entry =>
    entry.instructions === undefined ? [] : [{ harness: entry.harness, ...entry.instructions }],
  );
  const [first, second] = found;
  const make = (name: string, text: string, sources: string[], harness?: HarnessKind): Candidate => {
    const file = componentFilePath('instructions', name, 'md');
    const value: InstructionsComponent = { file, ...(harness === undefined ? {} : { harness }) };
    return {
      component: { kind: 'instructions', name, value },
      files: [{ kind: 'write', path: file, content: text }],
      sources,
      digestText: `${JSON.stringify(value)}\n${text}`,
      warnings: [],
    };
  };
  if (first === undefined) return { candidates: [] };
  if (second === undefined) {
    // Only one harness has instructions: they stay that harness's, so the other is not handed them.
    const narrowed = harvests.length > 1 ? first.harness : undefined;
    const name = narrowed === undefined ? IMPORT_NAMES.sharedInstructions : harnessNamed(first.harness, 'instructions');
    return { candidates: [make(name, first.text, [first.source], narrowed)] };
  }
  if (sameText(first.text, second.text)) {
    return {
      candidates: [make(IMPORT_NAMES.sharedInstructions, first.text, [first.source, second.source])],
      identical: true,
    };
  }
  return {
    candidates: found.map(entry =>
      make(harnessNamed(entry.harness, 'instructions'), entry.text, [entry.source], entry.harness),
    ),
    identical: false,
  };
}

function mcpCandidates(harvests: readonly HarnessHarvest[]): { candidates: Candidate[]; notes: ImportNote[] } {
  const notes: ImportNote[] = [];
  const byName = new Map<string, { harness: HarnessKind; server: HarnessHarvest['mcp'][number] }[]>();
  for (const entry of harvests) {
    for (const server of entry.mcp)
      byName.set(server.name, [...(byName.get(server.name) ?? []), { harness: entry.harness, server }]);
  }
  const both = harvests.length > 1;
  const candidates: Candidate[] = [];
  const make = (name: string, server: HarnessHarvest['mcp'][number], sources: string[], harness?: HarnessKind) => {
    const value: McpComponent = { ...server.value, ...(harness === undefined ? {} : { harness }) };
    candidates.push({
      component: { kind: 'mcp', name, value },
      files: [],
      sources,
      digestText: JSON.stringify(value),
      warnings: server.warnings,
    });
  };
  for (const [name, holders] of byName) {
    const [first, second] = holders;
    if (first === undefined) continue;
    if (second === undefined) {
      make(name, first.server, [first.server.source], both ? first.harness : undefined);
    } else if (sameJson(first.server.value, second.server.value)) {
      make(name, first.server, [first.server.source, second.server.source]);
    } else {
      make(name, first.server, [first.server.source], first.harness);
      const renamed = `${name}-${second.harness}`;
      make(renamed, second.server, [second.server.source], second.harness);
      notes.push({
        harness: second.harness,
        text: `Your ${HARNESS_DISPLAY_NAMES[second.harness]} MCP server "${name}" differs from the ${HARNESS_DISPLAY_NAMES[first.harness]} one, so it was kept separately as "${renamed}".`,
      });
    }
  }
  return { candidates, notes };
}

function skillsCandidates(harvests: readonly HarnessHarvest[]): { candidates: Candidate[]; notes: ImportNote[] } {
  const notes: ImportNote[] = [];
  const both = harvests.length > 1;
  const store = new Map<string, HostSkill>();
  const shared: string[] = [];
  const own = new Map<HarnessKind, string[]>();
  const files: ImportFile[] = [];
  const sources = new Map<string, string[]>();
  const place = (item: string, skill: HostSkill): void => {
    store.set(item, skill);
    files.push({ kind: 'copy-directory', path: skillStorePath(item), from: skill.source });
  };
  const holders = new Map<string, { harness: HarnessKind; skill: HostSkill }[]>();
  for (const entry of harvests) {
    for (const skill of entry.skills)
      holders.set(skill.item, [...(holders.get(skill.item) ?? []), { harness: entry.harness, skill }]);
  }
  const ownOf = (harness: HarnessKind): string[] => {
    const list = own.get(harness) ?? [];
    own.set(harness, list);
    return list;
  };
  for (const [item, found] of holders) {
    const [first, second] = found;
    if (first === undefined) continue;
    if (second === undefined) {
      place(item, first.skill);
      (both ? ownOf(first.harness) : shared).push(item);
      sources.set(item, [first.skill.source]);
    } else if (first.skill.digest === second.skill.digest) {
      place(item, first.skill);
      shared.push(item);
      sources.set(item, [first.skill.source, second.skill.source]);
    } else {
      place(item, first.skill);
      ownOf(first.harness).push(item);
      sources.set(item, [first.skill.source]);
      const renamed = `${item}-${second.harness}`;
      place(renamed, second.skill);
      ownOf(second.harness).push(renamed);
      sources.set(renamed, [second.skill.source]);
      notes.push({
        harness: second.harness,
        text: `Your ${HARNESS_DISPLAY_NAMES[second.harness]} skill "${item}" differs from the ${HARNESS_DISPLAY_NAMES[first.harness]} one, so it was kept separately as "${renamed}".`,
      });
    }
  }
  const make = (name: string, items: readonly string[], harness?: HarnessKind): Candidate => {
    const value: SkillsComponent = { items: [...items], ...(harness === undefined ? {} : { harness }) };
    return {
      component: { kind: 'skills', name, value },
      files: files.filter(file => items.some(item => file.path === skillStorePath(item))),
      sources: items.flatMap(item => sources.get(item) ?? []),
      digestText: `${JSON.stringify(value)}\n${items.map(item => store.get(item)?.digest ?? '').join('\n')}`,
      warnings: [],
    };
  };
  const candidates: Candidate[] = [];
  if (shared.length > 0) candidates.push(make(IMPORT_NAMES.sharedSkills, shared));
  for (const entry of harvests) {
    const items = own.get(entry.harness);
    if (items !== undefined && items.length > 0) {
      candidates.push(make(harnessNamed(entry.harness, 'skills'), items, entry.harness));
    }
  }
  return { candidates, notes };
}

function harnessCandidates(entry: HarnessHarvest): Candidate[] {
  const candidates: Candidate[] = [];
  if (entry.settings !== undefined) {
    const { value, content, source } = entry.settings;
    candidates.push({
      component: { kind: 'settings', name: harnessNamed(entry.harness, 'settings'), value },
      files: content === undefined || value.file === undefined ? [] : [{ kind: 'write', path: value.file, content }],
      sources: [source],
      digestText: `${JSON.stringify(value)}\n${content ?? ''}`,
      warnings: [],
    });
  }
  if (entry.hooks !== undefined) {
    const name = harnessNamed(entry.harness, 'hooks');
    const file = componentFilePath('hooks', name, 'json');
    const value: HooksComponent = { harness: entry.harness, file };
    candidates.push({
      component: { kind: 'hooks', name, value },
      files: [{ kind: 'write', path: file, content: entry.hooks.content }],
      sources: [entry.hooks.source],
      digestText: `${JSON.stringify(value)}\n${entry.hooks.content}`,
      warnings: [],
    });
  }
  candidates.push({
    component: { kind: 'modelSets', name: harnessNamed(entry.harness, 'models'), value: entry.modelSet },
    files: [],
    sources: [entry.settings?.source ?? `Ferretry's starter model for ${entry.harness}`],
    digestText: JSON.stringify(entry.modelSet),
    warnings: [],
  });
  return candidates;
}

/** What a harness's login becomes: a pointer to the person's own (`host`), or an empty slot. */
function credentialOf(harness: HarnessKind, login: HostLogin): Credential {
  return login.state === 'not-shareable' ? { harness, store: 'ferretry' } : { harness, store: 'host' };
}

function loginNote(harness: HarnessKind, login: HostLogin): string {
  const label = HARNESS_DISPLAY_NAMES[harness];
  const own = harness === 'claude' ? 'claude' : 'codex';
  const who = login.email === undefined ? 'your login' : login.email;
  switch (login.state) {
    case 'signed-in':
      return `Login · ${who}. Ferretry and your own \`${own}\` share this login: signing out in one signs out both.`;
    case 'refresh-due':
      return `Login · ${who} · Refresh due. Ferretry renews it the first time you launch.`;
    case 'not-signed-in':
      return `${label} isn't signed in on this machine. Your setup was still imported; sign in later and every runtime on this login can launch.`;
    case 'unreadable':
      return `Ferretry couldn't read your ${label} login (${login.reason ?? 'no reason given'}). It is still shared in place; check it on the Credentials tab.`;
    default:
      return `Your ${label} login can't be shared in place (${login.reason ?? 'it is not kept in a file'}), so this login needs its own sign-in.`;
  }
}

/** The installed harnesses a scan list should import, in a stable order. */
const importedHarnesses = (scans: readonly HostHarnessScan[], include?: readonly HarnessKind[]): HarnessKind[] =>
  (['claude', 'codex'] as const).filter(
    harness =>
      scans.some(scan => scan.harness === harness && scan.command !== undefined) &&
      (include === undefined || include.includes(harness)),
  );

function previewOf(scan: HostHarnessScan, entry: HarnessHarvest | undefined): HarnessImportPreview {
  const base = {
    harness: scan.harness,
    installed: scan.command !== undefined,
    account: scan.login,
    missingCommands: [...scan.missingCommands],
  };
  if (entry === undefined) {
    return { ...base, mcpServers: [], skills: [], secretKeys: [], problems: [...scan.problems] };
  }
  return {
    ...base,
    ...(scan.instructions.kind === 'text' && entry.instructions !== undefined
      ? {
          instructions: {
            name: HOST_INSTRUCTIONS_NAME[scan.harness],
            source: scan.instructions.source,
            bytes: scan.instructions.bytes,
          },
        }
      : {}),
    ...(entry.settings !== undefined || entry.hooks !== undefined
      ? {
          settings: {
            source: entry.settings?.source ?? entry.hooks?.source ?? scan.settings.source,
            count: entry.settings?.count ?? 0,
            hooks: entry.hooks?.count ?? 0,
          },
        }
      : {}),
    mcpServers: entry.mcp.map(server => server.name),
    skills: entry.skills.map(skill => skill.item),
    secretKeys: [...entry.secretKeys],
    problems: [...entry.problems],
  };
}

/**
 * The scan as the first run shows it (§7 `/v1/fleet/setup/scan`): what each harness has, and no
 * value of anything. Secret-looking keys are named; their values are not in this result at all.
 */
export function importPreview(scans: readonly HostHarnessScan[]): ImportPreview {
  return planImport(scans, { digest: text => text }).preview;
}

/**
 * Plan an import of the given harnesses' setups (§4.3 steps 2–4, Import again).
 *
 * Total: a document that cannot be read becomes a problem sentence in the preview and the rest of
 * the harness still imports.
 */
export function planImport(scans: readonly HostHarnessScan[], options: ImportOptions): ImportPlan {
  const existing = options.existing;
  const record = options.record ?? EMPTY_IMPORT_RECORD;
  const names = new SecretNames(options.existingSecrets ?? []);
  const secrets: ImportedSecret[] = [];
  const imported = importedHarnesses(scans, options.include);
  const harvests = imported.map(harness =>
    harvest(scans.find(scan => scan.harness === harness) as HostHarnessScan, names, secrets),
  );
  const harvestOf = (harness: HarnessKind) => harvests.find(entry => entry.harness === harness);

  const instructions = instructionsCandidates(harvests);
  const mcp = mcpCandidates(harvests);
  const skills = skillsCandidates(harvests);
  const candidates = [
    ...instructions.candidates,
    ...mcp.candidates,
    ...skills.candidates,
    ...harvests.flatMap(harnessCandidates),
  ];

  const notes: ImportNote[] = [];
  for (const entry of harvests) {
    const scan = scans.find(each => each.harness === entry.harness) as HostHarnessScan;
    notes.push({ harness: entry.harness, text: loginNote(entry.harness, scan.login) });
    if (entry.secretKeys.length > 0) {
      notes.push({
        harness: entry.harness,
        text: `${String(entry.secretKeys.length)} secret value${entry.secretKeys.length === 1 ? '' : 's'} went to Ferretry's secret store and ${entry.secretKeys.length === 1 ? 'is' : 'are'} never shown: ${entry.secretKeys.join(', ')}.`,
      });
    }
  }
  for (const scan of scans) {
    if (scan.command === undefined) {
      notes.push({
        harness: scan.harness,
        text: `${HARNESS_DISPLAY_NAMES[scan.harness]} isn't installed · Install later in Settings.`,
      });
    }
  }
  if (instructions.identical !== undefined) {
    notes.push({
      harness: 'codex',
      text: instructions.identical
        ? 'Instructions: same as your CLAUDE.md · one shared copy.'
        : 'Instructions: different from your CLAUDE.md · kept separately.',
    });
  }
  notes.push(...mcp.notes, ...skills.notes);

  // Import again: keep what is new, offer what changed, leave what the person made alone.
  const components: ImportedComponent[] = [];
  const files: ImportFile[] = [];
  const keptSecrets = new Set<string>();
  const updates: ImportUpdate[] = [];
  const warnings: Record<string, readonly string[]> = {};
  const recordEntries: Record<string, ImportRecordEntry> = { ...record.components };
  const added: LayerReferenceText[] = [];
  const taken = (kind: ComponentKind, name: string): boolean =>
    existing?.components[kind][name] !== undefined || components.some(item => item.kind === kind && item.name === name);
  const secretsOf = (candidate: Candidate): ImportedSecret[] => {
    const referenced = new Set(secretReferencesIn(JSON.stringify(candidate.component.value)));
    return secrets.filter(secret => referenced.has(secret.name));
  };
  for (const candidate of candidates) {
    const { kind, name } = candidate.component;
    const digest = options.digest(candidate.digestText);
    const reference = referenceOf(kind, name);
    const previous = record.components[reference];
    if (existing?.components[kind][name] !== undefined && previous !== undefined) {
      if (previous.digest !== digest) {
        updates.push({
          reference,
          sources: candidate.sources,
          component: candidate.component,
          files: candidate.files,
          secrets: secretsOf(candidate),
          digest,
        });
      }
      continue;
    }
    // A name the person already used for something of their own: the import takes the next free one.
    const free = freeName(name, candidate_ => taken(kind, candidate_));
    const component = { ...candidate.component, name: free } as ImportedComponent;
    const renamedFiles =
      free === name
        ? candidate.files
        : candidate.files.map(file =>
            file.kind === 'write' && file.path.startsWith(`components/${kind}/${name}.`)
              ? { ...file, path: file.path.replace(`/${name}.`, `/${free}.`) }
              : file,
          );
    const value = component.value as { file?: string };
    if (free !== name && value.file !== undefined) {
      (component as { value: { file?: string } }).value = {
        ...value,
        file: value.file.replace(`/${name}.`, `/${free}.`),
      };
    }
    components.push(component);
    files.push(...renamedFiles);
    for (const secret of secretsOf(candidate)) keptSecrets.add(secret.name);
    const freeReference = referenceOf(kind, free);
    added.push(freeReference);
    recordEntries[freeReference] = { sources: candidate.sources, digest };
    if (candidate.warnings.length > 0) warnings[freeReference] = candidate.warnings;
  }

  // The profiles: ONE PER IMPORTED HARNESS (P7 — a profile is Generic, Claude only or Codex only,
  // never both), each holding the generic parts and that harness's own. Import again extends the
  // profile an earlier import made for a harness, or makes one for a harness imported for the first
  // time. A record written before P7 names one shared profile, which is extended as it always was.
  const anyFound = harvests.some(entry => entry.found);
  const profiles: Record<string, LayeredProfile> = {};
  const ordered = (layers: readonly LayerReferenceText[]): LayerReferenceText[] =>
    [...layers].sort(
      (left, right) =>
        LAYER_ORDER.indexOf(left.slice(0, left.indexOf('/')) as ComponentKind) -
        LAYER_ORDER.indexOf(right.slice(0, right.indexOf('/')) as ComponentKind),
    );
  const componentAt = (reference: string): unknown => {
    const parsed = parseLayerReference(reference);
    if (parsed?.kind !== 'component') return undefined;
    const made = components.find(item => item.kind === parsed.componentKind && item.name === parsed.name);
    return made === undefined ? existing?.components[parsed.componentKind][parsed.name] : made.value;
  };
  const fitsOn = (harness: HarnessKind) => (reference: LayerReferenceText) =>
    scopeFits(
      componentScope(reference.slice(0, reference.indexOf('/')) as ComponentKind, componentAt(reference)),
      harness,
    );
  const profileOf: Partial<Record<HarnessKind, string>> = {};
  for (const harness of imported) {
    const known = record.profiles?.[harness] ?? record.profile;
    if (known !== undefined && existing?.profiles[known] !== undefined) profileOf[harness] = known;
  }
  for (const known of new Set(Object.values(profileOf))) {
    const on = imported.filter(harness => profileOf[harness] === known);
    const before = (existing as AccountModel).profiles[known]?.layers ?? [];
    const fresh = added.filter(
      reference => !before.includes(reference) && on.some(harness => fitsOn(harness)(reference)),
    );
    if (fresh.length > 0) profiles[known] = { layers: [...before, ...ordered(fresh)] };
  }
  for (const harness of imported) {
    if (profileOf[harness] !== undefined) continue;
    // A harness imported for the first time: what an earlier import made that fits it, then what is new.
    const earlier = Object.keys(record.components).filter(
      reference => !added.includes(reference as LayerReferenceText) && componentAt(reference) !== undefined,
    ) as LayerReferenceText[];
    const fitting = [...earlier, ...added].filter(fitsOn(harness));
    // Something found now, or something an earlier import found, is a Default; only model sets is a
    // Starter. Never empty: the harness's model set is always new or recorded.
    const found = anyFound || fitting.some(reference => !reference.startsWith('modelSets/'));
    const layers = ordered(fitting);
    const wanted = importedRuntimeName(harness, found ? IMPORT_NAMES.defaultProfile : IMPORT_NAMES.starterProfile);
    const name = freeName(
      wanted,
      candidate => existing?.profiles[candidate] !== undefined || profiles[candidate] !== undefined,
    );
    profiles[name] = { layers };
    profileOf[harness] = name;
    if (!found) {
      notes.push({
        harness,
        text: 'Nothing found. A plain Starter profile with only a model set. You can add to it later.',
      });
    }
  }

  // Credentials and runtimes.
  const credentials: Record<string, Credential> = {};
  const runtimes: Record<string, Runtime> = {};
  const duplicates: ImportDuplicate[] = [];
  for (const harness of imported) {
    const scan = scans.find(each => each.harness === harness) as HostHarnessScan;
    const wanted = credentialOf(harness, scan.login);
    const reuse =
      wanted.store === 'host'
        ? Object.entries(existing?.credentials ?? {}).find(
            ([, credential]) => credential.harness === harness && credential.store === 'host',
          )?.[0]
        : undefined;
    const credentialId =
      reuse ?? freeName(harnessNamed(harness, 'you'), candidate => existing?.credentials[candidate] !== undefined);
    if (reuse === undefined) credentials[credentialId] = wanted;
    const profileName = profileOf[harness];
    if (profileName === undefined) continue;
    const suggested = freeName(
      profileName.startsWith(`${harness}-`) ? profileName : importedRuntimeName(harness, profileName),
      candidate => existing?.runtimes[candidate] !== undefined || runtimes[candidate] !== undefined,
    );
    const twin = Object.entries(existing?.runtimes ?? {}).find(
      ([, runtime]) => runtime.credential === credentialId && runtime.profile === profileName,
    )?.[0];
    if (twin !== undefined && !(options.addDuplicates ?? []).includes(harness)) {
      duplicates.push({ harness, existing: twin, suggested });
      continue;
    }
    if (!isRuntimeName(suggested)) continue;
    runtimes[suggested] = { credential: credentialId, profile: profileName, agent: true };
  }

  const recordedProfiles: Partial<Record<HarnessKind, string>> = { ...record.profiles, ...profileOf };

  const preview: ImportPreview = {
    harnesses: scans.map(scan => previewOf(scan, harvestOf(scan.harness))),
    ...(instructions.identical === undefined ? {} : { instructionsIdentical: instructions.identical }),
  };

  return {
    preview,
    imported,
    credentials,
    components,
    profiles,
    runtimes,
    files,
    secrets: secrets.filter(secret => keptSecrets.has(secret.name)),
    warnings,
    notes,
    updates,
    duplicates,
    record: {
      version: 1,
      components: recordEntries,
      ...(record.profile === undefined ? {} : { profile: record.profile }),
      ...(Object.keys(recordedProfiles).length === 0 ? {} : { profiles: recordedProfiles }),
    },
  };
}

/** A configuration to import into when the machine has none yet. */
const EMPTY_MODEL: AccountModelDocument = { version: 2 };

/**
 * The configuration after an import: what is there, plus what the plan adds, plus each offered
 * update the person ACCEPTED (O6 — an update is never applied unless named here). Parsed, so a plan
 * that would make an invalid document is refused here rather than written.
 */
export function mergeImport(
  existing: AccountModel | undefined,
  plan: ImportPlan,
  acceptedUpdates: readonly LayerReferenceText[] = [],
): AccountModel {
  const base = (existing ?? parseAccountModel(EMPTY_MODEL)) as AccountModel;
  const components = Object.fromEntries(
    Object.entries(base.components).map(([kind, entries]) => [kind, { ...entries }]),
  ) as Record<ComponentKind, Record<string, unknown>>;
  const accepted = plan.updates.filter(update => acceptedUpdates.includes(update.reference));
  for (const component of [...plan.components, ...accepted.map(update => update.component)]) {
    components[component.kind][component.name] = component.value;
  }
  return parseAccountModel({
    ...base,
    credentials: { ...base.credentials, ...plan.credentials },
    components,
    profiles: { ...base.profiles, ...plan.profiles },
    runtimes: { ...base.runtimes, ...plan.runtimes },
  });
}

/** The record after an import, including each accepted update's new digest. */
export function mergeImportRecord(plan: ImportPlan, acceptedUpdates: readonly LayerReferenceText[] = []): ImportRecord {
  const components: Record<string, ImportRecordEntry> = { ...plan.record.components };
  for (const update of plan.updates) {
    if (acceptedUpdates.includes(update.reference)) {
      components[update.reference] = { sources: update.sources, digest: update.digest };
    }
  }
  return { ...plan.record, components };
}
