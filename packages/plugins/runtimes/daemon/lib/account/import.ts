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
import { secretReference, secretReferencesIn } from '@ferretry/core-vault/contract';
import { looksSecret } from '@ferretry/std/credential-words';
import { GITHUB_TOKEN_NAMES, maskedVariableName, nameLooksLikeKey } from '@ferretry/plugin-logins/contract';
import {
  importItemId,
  importNamedItemId,
  type KitImportedEnvironment as EnvImport,
  type RuntimesHarnessKit,
} from '../../../contract/index.ts';
import { harnessNamed } from './import-scope.ts';
import { isUsableSkillItemName } from '../assets.ts';
import { RESERVED_ENV_NAMES } from '../config.ts';
import { displayNameOf, harnessKeyOfKind, UnsupportedHarnessError } from '../harness-kind.ts';
import type { StarterModels } from '../models/catalog.ts';
import type { HarnessKind } from '../manifest.ts';
import {
  parseSettings,
  SettingsParseError,
  type SettingsFormat,
  type SettingsObject,
  serializeSettings,
} from '../settings.ts';
import { modelHarness } from './layering.ts';
import { secretNameAt } from './secret-names.ts';
import {
  type AccountModel,
  type ComponentKind,
  type Credential,
  type InstructionsComponent,
  type LayeredProfile,
  type LayerReferenceText,
  type McpComponent,
  type ModelSetComponent,
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
type HostLoginState = 'signed-in' | 'refresh-due' | 'not-signed-in' | 'unreadable' | 'not-shareable' | 'unknown';

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

/**
 * A project folder the host has its own instructions file for (Claude's `~/.claude.json` `projects` keys). The
 * instructions stay in the project, where agents read them; nothing in the folder is read here. `verified` is
 * whether the file was seen to exist, which Runtimes can only do where the kernel serves the folder.
 */
export interface ProjectInstructionHint {
  readonly path: string;
  readonly file: string;
  readonly verified: boolean;
}

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
  /** Codex only: `hooks.json`. Claude's hooks are the `hooks` block of its settings. Only COUNTED: an import never takes hooks. */
  readonly hooks?: HostDocumentRead;
  /** Claude only: project folders the host keeps instructions for. Never read, see {@link ProjectInstructionHint}. */
  readonly projectInstructions?: readonly ProjectInstructionHint[];
  readonly skills: readonly HostSkill[];
  /** MCP commands that resolve to nothing on this machine (E8), by command name. */
  readonly missingCommands: readonly string[];
  /** Sentences for anything the scan could not read that is not one of the documents above. */
  readonly problems: readonly string[];
}

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
  /** The Vault already holds exactly this value under this name from an earlier import: it is referenced, never filed again. */
  readonly reused?: true;
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
  /**
   * Source skills the person left out when this component was made (names only). A later scan compares only what was
   * imported, so a skill that was left out is never a change to offer; one that is new to the source still is.
   */
  readonly left?: readonly string[];
  /** The owner's own items (a skill folder, a Codex profile item) an import created through this component. */
  readonly owned?: readonly string[];
  /** The config etag each owned file had when an import wrote it, by item name: an update replaces only an item still at it. */
  readonly etags?: Readonly<Record<string, string>>;
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
  /** The skills still left out, once this update is taken. */
  readonly left?: readonly string[];
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
  | { readonly kind: 'modelSets'; readonly name: string; readonly value: ModelSetComponent };

/** The value-free preview the scan route serves (§7 `/v1/fleet/setup/scan`). */
export interface HarnessImportPreview {
  readonly harness: HarnessKind;
  readonly installed: boolean;
  readonly account: HostLogin;
  readonly instructions?: { readonly name: string; readonly source: string; readonly bytes: number };
  /** Settings found: how many, and how many hooks the host has (counted, never imported). */
  readonly settings?: { readonly source: string; readonly count: number; readonly hooks: number };
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  /** Codex's `[profiles.*]`: names, and the model and effort each sets. */
  readonly codexProfiles: readonly CodexProfileHint[];
  /** Folders whose own instructions the host knows; they stay in each project and are never imported. */
  readonly projectInstructions: readonly ProjectInstructionHint[];
  /** Secret-looking keys, by NAME only (`env.ANTHROPIC_API_KEY`). */
  readonly secretKeys: readonly string[];
  readonly missingCommands: readonly string[];
  /** Sentences for anything that could not be read or imported. */
  readonly problems: readonly string[];
}

/** A Codex profile as the scan lists it: nothing but its name and the two keys the import would keep. */
interface CodexProfileHint {
  readonly name: string;
  readonly model?: string;
  readonly effort?: string;
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
  /** Each imported harness's own `env`, for the login its runtime launches on (r9 A8). */
  readonly loginEnvs: readonly ImportedLoginEnv[];
  /** Per-component warnings that do not block saving (K6), keyed by layer reference. */
  readonly warnings: Readonly<Record<string, readonly string[]>>;
  readonly notes: readonly ImportNote[];
  readonly updates: readonly ImportUpdate[];
  readonly duplicates: readonly ImportDuplicate[];
  /** The starter models the plan was made with: a merge onto a machine with no files builds its built-in profiles from them. */
  readonly starters: StarterModels;
  /** The record to persist once this plan has been applied. */
  readonly record: ImportRecord;
}

export interface ImportOptions {
  /** The kit each installed harness's own plugin gives this import. */
  readonly kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined;
  /** The harnesses the person chose to import. Default: every installed one. */
  readonly include?: readonly HarnessKind[];
  /**
   * Items the person chose to leave out, as `import-items.ts` spells them (`claude-code:mcp:notes`). An item
   * named here is never harvested: it brings no component, no file and no secret.
   */
  readonly skip?: readonly string[];
  /** The machine's current configuration, for Import again. */
  readonly existing?: AccountModel;
  readonly record?: ImportRecord;
  /** Secret names already in the store, so an import never overwrites one. */
  readonly existingSecrets?: readonly string[];
  /** Held names the Vault confirmed an earlier import filed with this very value (name -> the host's own value): reused, not skipped. */
  readonly reusableSecrets?: ReadonlyMap<string, string>;
  /**
   * GitHub token variables of a harness's own `env` the person ticked (names only). A token that is not named here is NOT
   * imported: no secret is filed for it and nothing reaches a component or the login (r9 A8). Absent: none is imported.
   */
  readonly tickedEnv?: readonly string[];
  /** Harnesses whose duplicate runtime should be created anyway ("Add another anyway"). */
  readonly addDuplicates?: readonly HarnessKind[];
  /** The model each harness starts with when the host names none: the catalog default, from whoever holds Logins' catalogs. */
  readonly starters?: StarterModels;
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

// The pure word tests (`looksSecret`, `secretNamed`, `pointsElsewhere`, the token formats) are `@ferretry/std`'s: ONE
// implementation, shared with the kernel's read mask and this plugin's command-line views. This file keeps what is the
// FLEET's: when an import refuses a secret, and what it writes in its place.

/** A secret name in the store's grammar, from an environment variable name. */
const secretNameOf = (variable: string): string => {
  const upper = variable.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  const named = /^[A-Z]/u.test(upper) ? upper : `S_${upper}`;
  return named.slice(0, 64);
};

/** Hands out secret names, once per value, never one the store already holds. */
export class SecretNames {
  readonly #taken: Set<string>;
  readonly #byName = new Map<string, string>();

  constructor(
    existing: readonly string[],
    readonly reusable: ReadonlyMap<string, string> = new Map(),
  ) {
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
    for (let index = 2; !free(name) && this.reusable.get(name) !== value; index += 1) name = secretNameAt(base, index);
    const reused = !free(name);
    this.#byName.set(name, value);
    secrets.push({ name, value, from, ...(reused ? { reused: true as const } : {}) });
    return name;
  }
}

/** The three variables that carry a GitHub account's token: the login's environment leaves them out unless ticked. */
const isGithubTokenName = (name: string): boolean => GITHUB_TOKEN_NAMES.includes(name.toUpperCase());

/** A host variable as written, for the imported login's environment (r9 A8). */
interface LoginEnvPlain {
  readonly name: string;
  readonly value: string;
}

/** A host variable whose value this plan files in the Vault, by NAME (r9 A8). */
interface LoginEnvMinted {
  readonly name: string;
  readonly secretName: string;
}

/**
 * The host's harness `env` for the login its runtime launches on (r9 A8): host text and the names of the secrets this plan
 * files, in two lists so a Vault reference only ever comes from a key the apply filed itself.
 */
export interface ImportedLoginEnv {
  readonly harness: HarnessKind;
  /** The login the apply selected or created for this harness. */
  readonly login: string;
  readonly plain: readonly LoginEnvPlain[];
  readonly minted: readonly LoginEnvMinted[];
}

/** An environment block with every secret-looking value replaced by a reference. */
function importEnv(
  env: unknown,
  keyPrefix: string,
  from: string,
  names: SecretNames,
  secrets: ImportedSecret[],
  /** Given for a harness's own `env`: a GitHub token variable not named here is left out before any secret is filed. */
  ticked?: ReadonlySet<string>,
): EnvImport {
  const result: EnvImport = { env: {}, secretKeys: [], dropped: [], gated: [], plain: [], minted: [] };
  if (!isRecord(env)) return result;
  for (const [variable, raw] of Object.entries(env)) {
    // A name that is itself shaped like a key is not repeated in a scan, a warning or a source label.
    const shown = `${keyPrefix}${maskedVariableName(variable)}`;
    // A key typed into the name box: skipped BEFORE anything is derived from it, so no Vault name is built from it.
    if (nameLooksLikeKey(variable)) {
      result.dropped.push(`${shown} (a name that looks like a key, so it was left out)`);
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      result.dropped.push(`${shown} (not a text value)`);
      continue;
    }
    const value = String(raw);
    if (ticked !== undefined && isGithubTokenName(variable) && !ticked.has(variable)) {
      result.dropped.push(`${shown} (a GitHub token: not imported unless you tick it)`);
      result.gated.push(shown);
      continue;
    }
    if ((RESERVED_ENV_NAMES as readonly string[]).includes(variable)) {
      result.dropped.push(`${shown} (Ferretry sets it for each runtime)`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
      result.dropped.push(`${shown} (not an environment variable name)`);
      continue;
    }
    if (looksSecret(variable, value)) {
      result.secretKeys.push(shown);
      const secretName = names.claim(variable, value, `${from} · ${shown}`, secrets);
      result.env[variable] = secretReference(secretName);
      result.minted.push({ name: variable, secretName });
      continue;
    }
    if (/\$\{secret:/u.test(value) && secretReferencesIn(value).length === 0) {
      result.dropped.push(`${shown} (a malformed secret reference)`);
      continue;
    }
    result.env[variable] = value;
    result.plain.push({ name: variable, value });
  }
  return result;
}

// ── Reading documents ────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    problems.push(`${what} at ${read.source} is not valid ${format}${parseLocation(error)}, so it was not imported`);
    return undefined;
  }
}

/**
 * WHERE a settings document stopped parsing, as ` (line 3, column 7)`, or nothing. The parsers quote the offending line of the
 * host's own file in their messages, and a host file holds API keys, so the parser's TEXT is never used: only the numbers
 * TOML's error carries (`SettingsParseError.line`/`column`), which can hold no credential. JSON's engine message gives no
 * place in the file, so a JSON file is named with the fixed sentence alone.
 */
function parseLocation(error: unknown): string {
  if (!(error instanceof SettingsParseError) || error.line === undefined || error.column === undefined) return '';
  return ` (line ${String(error.line)}, column ${String(error.column)})`;
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

/** The starter model set: the one model a harness starts with when nothing names another; none when no starter is known. */
const starterModelSet = (harness: HarnessKind, starters: StarterModels): ModelSetComponent | undefined => {
  const model = starters[harness];
  return model === undefined ? undefined : { models: [model], default: model };
};

/** The model set a harness's settings imply: the models it names for that harness, or the starter. */
function modelSetOf(
  harness: HarnessKind,
  settings: SettingsObject | undefined,
  starters: StarterModels,
): ModelSetComponent | undefined {
  const named = declaredModelIds(settings ?? {}).filter(id => modelHarness(id) === harness);
  const [first] = named;
  if (first === undefined) return starterModelSet(harness, starters);
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

function scannedServer(
  mcpImport: NonNullable<RuntimesHarnessKit['mcpImport']>,
  name: string,
  entry: unknown,
): ScannedMcpServer | undefined {
  if (!isRecord(entry)) return undefined;
  if (mcpImport.skipDisabled && entry.enabled === false) return undefined;
  const known = new Set(mcpImport.knownKeys);
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
export function scannedMcpServers(
  scan: HostHarnessScan,
  kit: RuntimesHarnessKit | undefined,
): readonly ScannedMcpServer[] {
  const mcpImport = kit?.mcpImport;
  if (mcpImport === undefined) throw new UnsupportedHarnessError(scan.harness);
  const problems: string[] = [];
  const document = parsedDocument(
    mcpImport.document === 'mcp' ? scan.mcp : scan.settings,
    mcpImport.format,
    mcpImport.file,
    problems,
  );
  const table = document?.[mcpImport.table];
  return Object.entries(isRecord(table) ? table : {}).flatMap(([name, entry]) => {
    const server = scannedServer(mcpImport, name, entry);
    return server === undefined ? [] : [server];
  });
}

// ── One harness, read into components ────────────────────────────────────────────────────────────

/** What one harness's scan turned into, before the two harnesses are reconciled. */
export interface HarnessHarvest {
  readonly harness: HarnessKind;
  readonly instructions?: { readonly text: string; readonly source: string };
  readonly settings?: {
    readonly value: SettingsComponent;
    readonly content?: string;
    readonly source: string;
    readonly count: number;
  };
  /** The host's hooks: where and how many, for "found N, not imported". Never a component, never their content. */
  readonly hooks?: { readonly source: string; readonly count: number };
  readonly codexProfiles: readonly CodexProfileHint[];
  readonly mcp: readonly {
    readonly name: string;
    readonly value: McpComponent;
    readonly source: string;
    readonly warnings: readonly string[];
  }[];
  readonly skills: readonly HostSkill[];
  /** Skills the person left out (their names), which the import never reads again as a change. */
  readonly skillsLeft: readonly string[];
  /** The host's models, else the starter; absent when the host names none and no starter is known. */
  readonly modelSet?: ModelSetComponent;
  readonly secretKeys: readonly string[];
  /** GitHub token variables left out until ticked (names only): listed by the scan, never filed. */
  readonly gatedKeys: readonly string[];
  /** The harness's own `env` for its login (r9 A8), when it has any and the person did not leave it out. */
  readonly loginEnv?: { readonly plain: readonly LoginEnvPlain[]; readonly minted: readonly LoginEnvMinted[] };
  readonly problems: readonly string[];
  /** Whether anything at all was found, which decides Default or Starter (E5). */
  readonly found: boolean;
}

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

export function harvest(
  scan: HostHarnessScan,
  names: SecretNames,
  secrets: ImportedSecret[],
  skip: ReadonlySet<string>,
  ticked: ReadonlySet<string>,
  starters: StarterModels,
  kit: RuntimesHarnessKit | undefined,
): HarnessHarvest {
  const { harness } = scan;
  const key = harnessKeyOfKind(harness);
  const skipped = (kind: 'instructions' | 'settings' | 'env' | 'model-set'): boolean =>
    skip.has(importItemId(key, kind));
  const problems: string[] = [...scan.problems];
  const secretKeys: string[] = [];
  if (kit?.importSetup === undefined) throw new UnsupportedHarnessError(harness);
  const { settingsFormat: format, settingsFile, instructionsName } = kit.importSetup;

  // Instructions.
  const instructionsProblem = unreadableReason(scan.instructions, instructionsName);
  if (instructionsProblem !== undefined) problems.push(instructionsProblem);
  const instructions =
    !skipped('instructions') && scan.instructions.kind === 'text' && scan.instructions.text.trim() !== ''
      ? { text: scan.instructions.text, source: scan.instructions.source }
      : undefined;

  // Settings, with the parts that become their own components taken out.
  const parsed = parsedDocument(scan.settings, format, settingsFile, problems);
  const rest: Record<string, unknown> = { ...(parsed ?? {}) };
  if (kit.harvest === undefined) throw new UnsupportedHarnessError(harness);
  const hooksDocument = parsedDocument(scan.hooks, 'json', 'hooks.json', problems);
  const taken = kit.harvest({
    rest,
    source: scan.settings.source,
    mcpSource: scan.mcp?.source,
    parsedEnv: parsed?.env,
    ...(hooksDocument === undefined || scan.hooks === undefined
      ? {}
      : { hooks: { source: scan.hooks.source, document: hooksDocument } }),
    skippedEnv: skipped('env'),
    skippedModelSet: skipped('model-set'),
    countHooks,
    importEnvironment: (value, prefix, source) => importEnv(value, prefix, source, names, secrets, ticked),
  });
  const { hooks, envImport } = taken;
  if (envImport !== undefined) {
    secretKeys.push(...envImport.secretKeys);
    if (envImport.dropped.length > 0) {
      problems.push(`Left out of your ${settingsFile}: ${envImport.dropped.join(', ')}.`);
    }
  }
  const env = envImport?.env ?? {};
  // What the person chose to leave out is filtered out HERE, before the model set is derived and the file is written:
  // a skipped profile (`<harness>:profile:<name>`) is gone from both. Skipped settings no longer decide the model set; `<harness>:model-set` does.
  const profileTable = rest.profiles;
  if (isRecord(profileTable)) {
    const kept = Object.fromEntries(
      Object.entries(profileTable).filter(([name]) => !skip.has(importNamedItemId(key, 'profile', name))),
    );
    if (Object.keys(kept).length === 0) delete rest.profiles;
    else rest.profiles = kept;
  }
  // The model set is its own choice (`<harness>:model-set`): the model the settings name is read before skipped settings drop it.
  const namedModel = rest.model;
  // Skipped settings drop everything but the profiles the person kept: each is its own item and stays importable.
  if (skipped('settings')) for (const name of Object.keys(rest)) if (name !== 'profiles') delete rest[name];
  const modelSource: SettingsObject = {
    ...(namedModel === undefined || skipped('model-set') ? {} : { model: namedModel }),
    ...(rest.profiles === undefined ? {} : { profiles: rest.profiles }),
    ...(taken.modelEnvironment === undefined ? {} : { env: taken.modelEnvironment }),
  };
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
  const { mcpSource } = taken;
  const mcp = scannedMcpServers(scan, kit).flatMap(server => {
    if (skip.has(importNamedItemId(key, 'mcp', server.name))) return [];
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

  const skillsLeft: string[] = [];
  const skills = scan.skills.filter(skill => {
    if (skip.has(importNamedItemId(key, 'skill', skill.item))) {
      skillsLeft.push(skill.item);
      return false;
    }
    if (isUsableSkillItemName(skill.item)) return true;
    problems.push(`Skill "${skill.item}" has a folder name Ferretry cannot use, so it was not imported.`);
    return false;
  });

  const modelSet = modelSetOf(harness, modelSource, starters);
  return {
    harness,
    ...(instructions === undefined ? {} : { instructions }),
    ...(settings === undefined ? {} : { settings }),
    ...(hooks === undefined ? {} : { hooks }),
    codexProfiles: taken.profileHints ?? [],
    mcp,
    skills,
    skillsLeft,
    ...(modelSet === undefined ? {} : { modelSet }),
    secretKeys,
    gatedKeys: envImport?.gated ?? [],
    ...(envImport === undefined || (envImport.plain.length === 0 && envImport.minted.length === 0)
      ? {}
      : { loginEnv: { plain: envImport.plain, minted: envImport.minted } }),
    problems,
    found: instructions !== undefined || settings !== undefined || mcp.length > 0 || skills.length > 0,
  };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────

/** One component the import wants, before Import again decides whether it is new. */
export interface Candidate {
  readonly component: ImportedComponent;
  readonly files: readonly ImportFile[];
  readonly sources: readonly string[];
  /** Over the component and its file content, so a changed source is a changed digest. */
  readonly digestText: string;
  readonly warnings: readonly string[];
  /** Skills of its harness the person left out, recorded so the next scan does not read them as a change. */
  readonly left?: readonly string[];
  /** The same candidate without those skills, for comparing with what an earlier import recorded. */
  readonly without?: (omit: ReadonlySet<string>) => Candidate;
}

export const referenceOf = (kind: ComponentKind, name: string): LayerReferenceText => `${kind}/${name}`;

const sameText = (left: string, right: string): boolean =>
  left.replace(/\r\n/gu, '\n').trimEnd() === right.replace(/\r\n/gu, '\n').trimEnd();

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** The layer order a Default profile reads in, as §5.2 shows it. */
export const LAYER_ORDER: readonly ComponentKind[] = ['instructions', 'mcp', 'skills', 'settings', 'modelSets'];

export function instructionsCandidates(harvests: readonly HarnessHarvest[]): {
  candidates: Candidate[];
  identical?: boolean;
  /** Which two harnesses' instructions were compared, when two were found. */
  compared?: { readonly first: HarnessKind; readonly second: HarnessKind };
} {
  const found = harvests.flatMap(entry =>
    entry.instructions === undefined ? [] : [{ harness: entry.harness, ...entry.instructions }],
  );
  const [first, second] = found;
  const make = (name: string, text: string, sources: string[], harness?: HarnessKind): Candidate => {
    // Instructions are Runtimes' own kind: the text is kept in the item itself (`config/instructions/<name>.yaml`), so the
    // model the apply leaves behind holds the component the profile names. A document under the asset tree is never read
    // back by the model's own source, which left the profile naming a component no read could find.
    const value: InstructionsComponent = { text, ...(harness === undefined ? {} : { harness }) };
    return {
      component: { kind: 'instructions', name, value },
      files: [],
      sources,
      digestText: `${JSON.stringify(harness === undefined ? {} : { harness })}\n${text}`,
      warnings: [],
    };
  };
  if (first === undefined) return { candidates: [] };
  if (second === undefined) {
    // Only one harness has instructions: they are that harness's own — named and scoped to it, even when it is the only
    // harness this pass imports — so a later import of the other tool adds ITS items instead of reading as an update of
    // these, and its profile is never handed them.
    return {
      candidates: [make(harnessNamed(first.harness, 'instructions'), first.text, [first.source], first.harness)],
    };
  }
  if (sameText(first.text, second.text)) {
    return {
      candidates: [make(IMPORT_NAMES.sharedInstructions, first.text, [first.source, second.source])],
      identical: true,
      compared: { first: first.harness, second: second.harness },
    };
  }
  return {
    candidates: found.map(entry =>
      make(harnessNamed(entry.harness, 'instructions'), entry.text, [entry.source], entry.harness),
    ),
    identical: false,
    compared: { first: first.harness, second: second.harness },
  };
}

export function mcpCandidates(harvests: readonly HarnessHarvest[]): { candidates: Candidate[]; notes: ImportNote[] } {
  const notes: ImportNote[] = [];
  const byName = new Map<string, { harness: HarnessKind; server: HarnessHarvest['mcp'][number] }[]>();
  for (const entry of harvests) {
    for (const server of entry.mcp)
      byName.set(server.name, [...(byName.get(server.name) ?? []), { harness: entry.harness, server }]);
  }
  const candidates: Candidate[] = [];
  const make = (name: string, server: HarnessHarvest['mcp'][number], sources: string[], harness?: HarnessKind) => {
    const value: McpComponent = { ...server.value, ...(harness === undefined ? {} : { harness }) };
    candidates.push({
      component: { kind: 'mcp', name, value },
      files: [],
      sources,
      // Over the server alone, never its scope: widening a server to both tools must not read as a change.
      digestText: JSON.stringify(server.value),
      warnings: server.warnings,
    });
  };
  for (const [name, holders] of byName) {
    const [first, second] = holders;
    if (first === undefined) continue;
    if (second === undefined) {
      make(name, first.server, [first.server.source], first.harness);
    } else if (sameJson(first.server.value, second.server.value)) {
      make(name, first.server, [first.server.source, second.server.source]);
    } else {
      make(name, first.server, [first.server.source], first.harness);
      const renamed = `${name}-${second.harness}`;
      make(renamed, second.server, [second.server.source], second.harness);
      notes.push({
        harness: second.harness,
        text: `Your ${displayNameOf(second.harness)} MCP server "${name}" differs from the ${displayNameOf(first.harness)} one, so it was kept separately as "${renamed}".`,
      });
    }
  }
  return { candidates, notes };
}

export function skillsCandidates(harvests: readonly HarnessHarvest[]): {
  candidates: Candidate[];
  notes: ImportNote[];
} {
  const notes: ImportNote[] = [];
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
      // One tool's skill is that tool's own, even when it is the only one this pass imports (see the instructions above).
      ownOf(first.harness).push(item);
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
        text: `Your ${displayNameOf(second.harness)} skill "${item}" differs from the ${displayNameOf(first.harness)} one, so it was kept separately as "${renamed}".`,
      });
    }
  }
  const make = (name: string, items: readonly string[], harness?: HarnessKind): Candidate => {
    const value: SkillsComponent = { items: [...items], ...(harness === undefined ? {} : { harness }) };
    const left = harvests.find(entry => entry.harness === harness)?.skillsLeft ?? [];
    return {
      ...(left.length === 0 ? {} : { left }),
      without: omit =>
        make(
          name,
          items.filter(item => !omit.has(item)),
          harness,
        ),
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

export function harnessCandidates(entry: HarnessHarvest): Candidate[] {
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
  if (entry.modelSet !== undefined)
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
export function credentialOf(harness: HarnessKind, login: HostLogin): Credential {
  return login.state === 'not-shareable' ? { harness, store: 'ferretry' } : { harness, store: 'host' };
}

export function loginNote(harness: HarnessKind, login: HostLogin, kit?: RuntimesHarnessKit): string {
  if (kit?.loginNote === undefined) throw new UnsupportedHarnessError(harness);
  return kit.loginNote(login);
}
