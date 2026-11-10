/**
 * What a caller may ask this machine's account model to become.
 *
 * A caller never sends a configuration document. It sends one named intent, and the daemon derives
 * the next model from the current one — which is what makes the change reviewable: an arbitrary
 * whole-config replacement can differ from what was previewed in ways nobody reads, while "add this
 * runtime" has one meaning and one derivation.
 */
import { type BrowserMode, type BrowserPortsSetting, type LoweredHarness, lowerHarness } from './foreign.ts';
import {
  type AccountModel,
  AccountModelSchema,
  type ComponentKind,
  isRuntimeName,
  resolveDefaultRuntime,
} from '../account/schema.ts';
import { componentFilePath, freeName, looksSecret } from '../account/import.ts';
import { credentialHarnesses } from '../account/halves.ts';
import {
  describeScopeConflict,
  HARNESS_SCOPE_WORDS,
  newlyMisfitRuntimes,
  newlyMixedProfiles,
  type ProfileScope,
  profileScope,
  runtimeHarness,
  scopeFits,
} from '../account/scope.ts';
import { HARNESS_DISPLAY_NAMES, resolveProfile } from '../account/layering.ts';
import type { HarnessKind } from '../manifest.ts';
import { parseSettings, type SettingsFormat, type SettingsObject, serializeSettings } from '../settings.ts';
import { type ShownWord, shownWords, shownWordsEtag } from './command-line.ts';
import { slugName } from '../account/document.ts';
import { holdsControlCharacter, INSTRUCTIONS_TEXT_LIMIT } from '../../../contract/index.ts';
import type {
  AccountChange as WireAccountChange,
  AgentControl,
  ComponentInput as WireComponentInput,
  EnvInput,
  KeptWord,
  RunningSession,
  SettingsEntriesInput,
} from '../../../contract/index.ts';
import {
  componentUsage,
  counted,
  editConsequence,
  KIND_WORDS,
  layersRefusal,
  listed,
  profileUsage,
  runtimesUsingCredential,
  runtimesUsingProfile,
} from './catalog.ts';

type MixedScope = Extract<ProfileScope, { kind: 'mixed' }>;

/** A refusal the caller can act on, rather than a schema violation or a daemon defect. */
export class FleetMutationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetMutationRefusal';
  }
}

// ── The account model's changes ──────────────────────────────────────────────────────────────────
//
// A caller names ONE intent and this derives the next model from the current one. A component's
// file path is never accepted from a caller — it is `components/<kind>/<name>.<ext>` in the asset
// tree — and the candidate is validated by the shared schema last, so every cross-reference the
// model has is checked once, in its own words.

// Inside this file a harness is `claude` or `codex` (the library's word); the wire says `claude-code`. A change is
// lowered once, at {@link deriveAccountChange}, and every function below reads the lowered shape.
type ComponentInput = LoweredHarness<WireComponentInput>;

/** Every change to ONE login: Logins stages and applies them (`ctx.needs.loginChanges`); Runtimes only carries a removal's runtimes. */
export type LoginAccountChange = Extract<
  WireAccountChange,
  {
    kind:
      | 'credential.add'
      | 'credential.env'
      | 'credential.label'
      | 'credential.remove'
      | 'credential.signout'
      | 'credential.disable'
      | 'credential.enable';
  }
>;

/** Whether Logins owns this change (every `credential.*`). */
export const isLoginAccountChange = (change: WireAccountChange): change is LoginAccountChange =>
  change.kind.startsWith('credential.');

/** A login's removal, as Runtimes sees it: the runtimes still on it, to move or remove before Logins removes the login. */
export type LoginRemoval = Extract<LoginAccountChange, { kind: 'credential.remove' }>;

/** The changes that derive a new configuration in Runtimes, as they arrive. Setup and clone run their own executors. */
export type AccountPlanChange = Exclude<
  WireAccountChange,
  LoginAccountChange | { kind: 'setup.import' } | { kind: 'clone.import' }
>;

type PlanChange = LoweredHarness<AccountPlanChange | LoginRemoval>;

/** The kinds that are not a configuration edit in Runtimes. */
const EXECUTED_KINDS: ReadonlySet<string> = new Set(['setup.import', 'clone.import']);

/** Whether this change derives a new configuration (and so goes through the plan and its apply). */
export const isAccountPlanChange = (change: WireAccountChange): change is AccountPlanChange =>
  !EXECUTED_KINDS.has(change.kind) && !isLoginAccountChange(change);

/** One component document a change writes, relative to the asset tree. */
export interface AccountComponentFile {
  readonly file: string;
  readonly content: string;
}

/** The model a change produces, the files it writes, and what the person approving it is told. */
export interface AccountModelEdit {
  readonly model: AccountModel;
  readonly files: readonly AccountComponentFile[];
  readonly summary: string;
  /** The sentences a confirm card shows (E15, E20, E21, E32). */
  readonly consequences: readonly string[];
  /** A removed login's secret NAMES that nothing else refers to now: left in the store, said aloud. */
  readonly orphanedSecrets?: readonly string[];
}

/** What a derivation needs to know about the machine that is not in its configuration. */
export interface AccountChangeFacts {
  readonly machineName: string;
  readonly runningSessions: number;
  /** Each settings component's parsed file, by name: what an edit by entry keeps a hidden value from. */
  readonly settingsBodies?: Readonly<Record<string, SettingsObject>>;
  /**
   * Every other spelling `ids.json` resolves to a runtime — each former name and each id — mapped to
   * the runtime it reaches, so a rename never takes a name that already starts something else.
   */
  readonly runtimeReferences?: Readonly<Record<string, string>>;
  /** The sessions still running on the runtime a `runtime.remove` or `runtime.rename` names, when known. */
  readonly runningOn?: readonly RunningSession[];
  /** The same, by runtime, for a change that touches several (removing a login that runtimes use). */
  readonly runningByRuntime?: Readonly<Record<string, readonly RunningSession[]>>;
}

/** The document format each harness's settings file is in. */
const SETTINGS_FORMAT: Readonly<Record<HarnessKind, SettingsFormat>> = { claude: 'json', codex: 'toml' };

/** The extension each kind's file is written with. */
const componentExtension = (input: ComponentInput): string | undefined => {
  if (input.kind === 'instructions') return 'md';
  if (input.kind === 'settings') return SETTINGS_FORMAT[input.harness];
  if (input.kind === 'hooks') return 'json';
  return undefined;
};

const refuse = (message: string): never => {
  throw new FleetMutationRefusal(message);
};

/**
 * E16: a name that is taken or does not fit R1, refused with the name to use instead. A name that is
 * not in the grammar is offered its nearest slug; a name that is taken is offered `-2`, `-3`, ….
 */
function assertFreeRuntimeName(
  name: string,
  taken: (candidate: string) => boolean,
  what: 'runtime' | 'login',
  machineName: string,
): void {
  if (!isRuntimeName(name)) {
    const suggestion = freeName(slugName(name, what === 'runtime' ? 'runtime' : 'login'), taken);
    refuse(`Use only letters, digits and dashes. Use ${suggestion}?`);
  }
  if (taken(name)) {
    refuse(`${name} is already a ${what} on ${machineName}. Use ${freeName(name, taken)}?`);
  }
}

/** E7: what a value that looks like a secret is refused with, wherever a component would hold it. */
const secretRefusal = (name: string): string =>
  `${name} looks like a secret, and a secret never sits in a component. Save it in this machine's secret store and write \${secret:NAME} here instead.`;

/**
 * A settings document built from the entries an edit sends, by dotted key, with every "keep" resolved
 * against the file the component has. The inverse of the catalogue's flattening: each dot nests one
 * object deeper, so `permissions.defaultMode` lands in `{ permissions: { defaultMode } }`.
 */
function settingsFromEntries(
  entries: SettingsEntriesInput,
  existing: SettingsObject | undefined,
  owner: string,
  format: SettingsFormat,
): string {
  const document: Record<string, unknown> = {};
  const leaves = new Set<string>();
  for (const [key, entry] of Object.entries(entries).toSorted(([left], [right]) => (left < right ? -1 : 1))) {
    const path = key.split('.');
    if (path.some(segment => segment === '')) refuse(`${owner} cannot have a setting named "${key}"`);
    let value: unknown;
    if ('keep' in entry) {
      const kept = keptValue(existing, path);
      if (kept === undefined) refuse(`${owner} has no value for ${key} to keep; type one`);
      value = kept;
    } else {
      // K4, E7: the same rule a component's environment follows, for a value typed into its file.
      if (looksSecret(key, typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value))) {
        refuse(secretRefusal(key));
      }
      value = entry.value;
    }
    // Sorted, so a key always comes before the keys inside it.
    const parent = path
      .slice(0, -1)
      .map((_, index) => path.slice(0, index + 1).join('.'))
      .find(prefix => leaves.has(prefix));
    if (parent !== undefined) refuse(`${owner} sets ${parent} and a setting inside it`);
    leaves.add(key);
    let table = document;
    for (const segment of path.slice(0, -1)) {
      table[segment] ??= {};
      table = table[segment] as Record<string, unknown>;
    }
    table[path.at(-1) as string] = value;
  }
  return serializeSettings(document, format);
}

/** The value at a dotted path in a parsed settings file, or `undefined` when it has none. */
function keptValue(settings: SettingsObject | undefined, path: readonly string[]): unknown {
  let value: unknown = settings;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

/** The environment an edit asks for, with every "keep" resolved against what the component has. */
function resolvedEnv(
  input: EnvInput | undefined,
  existing: Readonly<Record<string, string>> | undefined,
  owner: string,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      const kept = existing?.[name];
      if (kept === undefined) refuse(`${owner} has no value for ${name} to keep; type one`);
      env[name] = kept as string;
      continue;
    }
    // K4, E7: a secret value never sits in a component, only a reference to the secret store.
    if (looksSecret(name, value)) refuse(secretRefusal(name));
    env[name] = value;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/**
 * The launch flags or MCP arguments an edit asks for, with every "keep" resolved against the words the component has
 * (rulings #39, #40): the catalogue showed a word that carries a credential as hidden, so the form sends
 * `{ keep: true, at }` with the list's etag instead of a value it never held. A keep takes the word at its position
 * in the list as READ, so moving words in the edit moves no value; when the list has changed since (the etag no longer
 * matches) or holds no word there, it is refused in the environment's words. A typed word can never be the hidden
 * marker (the contract refuses it), so the marker is never saved as a value.
 *
 * NO KEEP MOVES A SECRET INTO SIGHT. A keep carries a word's value, not the word before it, and whether a value is
 * hidden can turn on that word (`--token`, `v`) or on the command before the first argument. So the words the edit
 * leaves are judged again by the same rule, and every kept word that was hidden as read must still be hidden where it
 * now stands, and shown the same; otherwise the keep is refused in the same words. A copy of a hidden word is held to
 * it too, so a duplicate keep stays hidden or is refused.
 */
function resolvedWords(
  input: readonly (string | KeptWord)[] | undefined,
  etag: string | undefined,
  existing: { readonly words: unknown; readonly first: unknown },
  first: unknown,
  owner: string,
  what: 'flag' | 'argument',
): string[] | undefined {
  if (input === undefined) return undefined;
  const nothingToKeep = (at: number): never =>
    refuse(`${owner} has no value for ${what} ${String(at + 1)} to keep; type one`);
  const stored = Array.isArray(existing.words) ? (existing.words as readonly string[]) : [];
  const read = shownWords(stored, typeof existing.first === 'string' ? existing.first : undefined);
  const current = shownWordsEtag(read);
  const words = input.map(word => {
    if (typeof word === 'string') return word;
    const kept = etag === current ? stored[word.at] : undefined;
    return kept ?? nothingToKeep(word.at);
  });
  const now = shownWords(words, typeof first === 'string' ? first : undefined);
  for (const [index, word] of input.entries()) {
    if (typeof word === 'string') continue;
    const was = read[word.at] as ShownWord;
    const is = now[index] as ShownWord;
    if (was.hidden && (!is.hidden || is.text !== was.text)) nothingToKeep(word.at);
  }
  return words;
}

/** A parsed settings or hooks document, or a refusal naming what is wrong with it. */
function assertDocument(text: string, format: SettingsFormat, what: string): void {
  try {
    parseSettings(text, format);
  } catch (error) {
    refuse(
      `the ${what} text is not valid ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Where an item came from: set by a copy, never by an edit, so an edit carries it over as it was. */
const CLONE_LINK_FIELDS = ['clonedFrom', 'clonedFromDaemon', 'clonedFromKey'] as const;

/** The copy provenance of an item that already exists, for the item an edit rebuilds in its place. */
function cloneLinkOf(existing: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const field of CLONE_LINK_FIELDS) {
    const value = existing?.[field];
    if (typeof value === 'string') carried[field] = value;
  }
  return carried;
}

/** The component as the configuration stores it, and the file it writes. */
function componentOf(
  name: string,
  input: ComponentInput,
  given: string | undefined,
  existing: Record<string, unknown> | undefined,
  existingSettings: SettingsObject | undefined,
): { readonly component: Record<string, unknown>; readonly file?: AccountComponentFile } {
  const built = componentBody(name, input, given, existing, existingSettings);
  return { ...built, component: { ...built.component, ...cloneLinkOf(existing) } };
}

function componentBody(
  name: string,
  input: ComponentInput,
  given: string | undefined,
  existing: Record<string, unknown> | undefined,
  existingSettings: SettingsObject | undefined,
): { readonly component: Record<string, unknown>; readonly file?: AccountComponentFile } {
  const owner = `${KIND_WORDS[input.kind]} ${name}`;
  const content =
    input.kind === 'settings' && input.entries !== undefined
      ? settingsFromEntries(input.entries, existingSettings, owner, SETTINGS_FORMAT[input.harness])
      : given;
  const extension = componentExtension(input);
  const ownFile = extension === undefined ? undefined : componentFilePath(input.kind, name, extension);
  const written = content === undefined || ownFile === undefined ? undefined : { file: ownFile, content };
  const keptFile = typeof existing?.file === 'string' ? existing.file : undefined;
  const file = written?.file ?? keptFile;
  const existingEnv = existing?.env as Readonly<Record<string, string>> | undefined;
  const harness = 'harness' in input && input.harness !== undefined ? { harness: input.harness } : {};
  switch (input.kind) {
    case 'instructions': {
      // Runtimes' own kind: the text is kept in the item itself, so an edit writes no document beside it.
      const text = given ?? (typeof existing?.text === 'string' ? existing.text : undefined);
      // An item imported from a document keeps pointing at it when only its fields change.
      if (text === undefined && keptFile !== undefined) return { component: { file: keptFile, ...harness } };
      const held = text ?? refuse(`${owner} needs its text`);
      // Refused here, when it is proposed, so nothing is written under a sentence that says nothing was changed.
      if (held.length > INSTRUCTIONS_TEXT_LIMIT)
        refuse(`${owner} is longer than ${String(INSTRUCTIONS_TEXT_LIMIT)} characters`);
      if (holdsControlCharacter(held))
        refuse(`${owner} holds a control character (NUL or another, besides tab and line breaks)`);
      return { component: { text: held, ...harness } };
    }
    case 'mcp': {
      const env = resolvedEnv(input.env, existingEnv, owner);
      const args = resolvedWords(
        input.args,
        input.argsEtag,
        { words: existing?.args, first: existing?.command },
        input.command,
        owner,
        'argument',
      );
      return {
        component: {
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(args === undefined ? {} : { args }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.auth === undefined ? {} : { auth: input.auth }),
          // A hand-registered client (`oauth`) has no field in the form: an edit that keeps the sign-in keeps it.
          ...(input.auth === 'oauth' && existing?.oauth !== undefined ? { oauth: existing.oauth } : {}),
          ...(env === undefined ? {} : { env }),
          ...harness,
        },
      };
    }
    case 'skills':
      return { component: { items: [...input.items], ...harness } };
    case 'settings': {
      if (content !== undefined) assertDocument(content, SETTINGS_FORMAT[input.harness], owner);
      const env = resolvedEnv(input.env, existingEnv, owner);
      const flags = resolvedWords(
        input.flags,
        input.flagsEtag,
        { words: existing?.flags, first: undefined },
        undefined,
        owner,
        'flag',
      );
      return {
        component: {
          harness: input.harness,
          ...(file === undefined ? {} : { file }),
          ...(flags === undefined || flags.length === 0 ? {} : { flags }),
          ...(env === undefined ? {} : { env }),
        },
        ...(written === undefined ? {} : { file: written }),
      };
    }
    case 'hooks': {
      if (content !== undefined) assertDocument(content, 'json', owner);
      const directory =
        typeof existing?.directory === 'string' && written === undefined ? existing.directory : undefined;
      if (directory !== undefined) {
        return { component: { harness: input.harness, directory } };
      }
      if (file === undefined) refuse(`${owner} needs its hooks document`);
      return { component: { harness: input.harness, file }, ...(written === undefined ? {} : { file: written }) };
    }
    default:
      return { component: { models: [...input.models], default: input.default } };
  }
}

type Draft = {
  machine: Record<string, unknown>;
  credentials: Record<string, Record<string, unknown>>;
  components: Record<ComponentKind, Record<string, Record<string, unknown>>>;
  profiles: Record<string, { layers: string[] } & Record<string, unknown>>;
  runtimes: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

/**
 * Derive the model one change asks for, validated by the shared schema, with the files it writes and
 * the sentences the person approving it reads. Throws {@link FleetMutationRefusal} for anything the
 * change cannot do, in words naming what to do instead.
 */
export function deriveAccountChange(
  model: AccountModel,
  change: AccountPlanChange | LoginRemoval,
  facts: AccountChangeFacts,
): AccountModelEdit {
  const draft = structuredClone(model) as unknown as Draft;
  const files: AccountComponentFile[] = [];
  const consequences: string[] = [];
  const summary = applyAccountChange(model, draft, lowerHarness(change), facts, files, consequences);
  const parsed = AccountModelSchema.safeParse(draft);
  if (!parsed.success) {
    refuse(`this change would leave the setup invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  const next = (parsed as { data: AccountModel }).data;
  // P7: no change may make a profile both Claude only and Codex only — not by its own layers (refused
  // above, by name) and not by narrowing a component or editing a base it reaches.
  const mixed = newlyMixedProfiles(model, next)[0];
  if (mixed !== undefined) refuse(describeScopeConflict(profileScope(next, mixed) as MixedScope, mixed));
  const misfit = newlyMisfitRuntimes(model, next)[0];
  if (misfit !== undefined) {
    refuse(
      `Runtime ${misfit.runtime} uses a ${HARNESS_DISPLAY_NAMES[misfit.harness]} login, and this change would make its profile ${misfit.profile} ${HARNESS_SCOPE_WORDS[misfit.scope]}. Move it to another profile first.`,
    );
  }
  return { model: next, files, summary, consequences };
}

function applyAccountChange(
  model: AccountModel,
  draft: Draft,
  change: PlanChange,
  facts: AccountChangeFacts,
  files: AccountComponentFile[],
  consequences: string[],
): string {
  switch (change.kind) {
    case 'runtime.put':
      return putRuntime(model, draft, change, facts, consequences);
    case 'runtime.remove': {
      if (model.runtimes[change.name] === undefined) refuse(`no runtime ${change.name} exists on this machine`);
      if (model.machine.defaultRuntime === change.name) {
        refuse(`${change.name} is this machine's default runtime for new agents. Pick another default first.`);
      }
      delete draft.runtimes[change.name];
      consequences.push(removalConsequence(facts.runningOn));
      return `Remove runtime ${change.name}`;
    }
    case 'runtime.rename':
      return renameRuntime(model, draft, change, facts, consequences);
    case 'profile.put':
      return putProfile(model, draft, change, facts, consequences);
    case 'profile.remove':
      return removeProfile(model, draft, change, consequences);
    case 'component.put':
      return putComponent(model, draft, change, facts, files, consequences);
    case 'component.remove':
      return removeComponent(model, draft, change, consequences);
    case 'runtime.disable': {
      if (model.runtimes[change.name] === undefined) return refuse(`no runtime ${change.name} exists on this machine`);
      (draft.runtimes[change.name] as Record<string, unknown>).disabled = disabledBlock(change);
      consequences.push(
        'Nothing running is stopped: ferrets already on this runtime keep going. New starts on it are refused.',
      );
      return `Disable runtime ${change.name}`;
    }
    case 'runtime.enable': {
      const runtime = model.runtimes[change.name];
      if (runtime === undefined) return refuse(`no runtime ${change.name} exists on this machine`);
      delete (draft.runtimes[change.name] as Record<string, unknown>).disabled;
      const login = model.credentials[runtime.credential];
      if (login?.disabled !== undefined) {
        consequences.push(
          `Its login ${runtime.credential} is still disabled, so ${change.name} stays off until that is enabled too.`,
        );
      }
      return `Enable runtime ${change.name}`;
    }
    case 'credential.remove':
      return removeCredential(model, draft, change, facts, consequences);
    default:
      return putMachineSettings(model, draft, change, facts, consequences);
  }
}

/**
 * `credential.remove`, the RUNTIMES half: every runtime still on the login is either switched to another login of the
 * same CLI or removed (the rules of `runtime.remove`: the machine's default runtime needs another default first), and a
 * login a runtime still uses is refused (C10) — here, first, because Logins cannot see runtime use. The login itself is
 * Logins' to remove (`login.remove`), and what that leaves behind (the secret store's entries, a Ferretry-kept login's
 * saved sign-in) is said by Logins' own consequences. The edit leaves `model.credentials` as it is.
 */
function removeCredential(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'credential.remove' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const credential = model.credentials[change.id];
  if (credential === undefined) return refuse(`no login ${change.id} exists on this machine`);
  const users = runtimesUsingCredential(model, change.id);
  const switches = Object.entries(change.switchRuntimes ?? {});
  const removals = [...new Set(change.removeRuntimes ?? [])];
  for (const name of [...switches.map(([runtime]) => runtime), ...removals]) {
    if (!users.includes(name)) refuse(`runtime ${name} does not use login ${change.id}, so this change cannot move it`);
  }
  const both = removals.find(name => change.switchRuntimes?.[name] !== undefined);
  if (both !== undefined) refuse(`runtime ${both} cannot be both switched and removed`);

  const byTarget = new Map<string, string[]>();
  for (const [name, to] of switches) {
    const target = model.credentials[to];
    if (to === change.id) refuse(`runtime ${name} cannot switch to the login being removed`);
    if (target === undefined) return refuse(`no login ${to} exists on this machine`);
    const runtime = model.runtimes[name];
    const harness = runtime === undefined ? undefined : runtimeHarness(model, runtime);
    if (runtime === undefined || harness === undefined) return refuse(`no runtime ${name} exists on this machine`);
    if (runtimeHarness(model, { ...runtime, credential: to }) !== harness) {
      refuse(
        `${name} runs ${HARNESS_DISPLAY_NAMES[harness]}, and login ${to} does not drive it. Pick a ${HARNESS_DISPLAY_NAMES[harness]} login.`,
      );
    }
    (draft.runtimes[name] as Record<string, unknown>).credential = to;
    byTarget.set(to, [...(byTarget.get(to) ?? []), name]);
  }

  const movesDefault = removals.includes(model.machine.defaultRuntime ?? '');
  if (movesDefault && change.defaultRuntime === undefined) {
    refuse(
      `${model.machine.defaultRuntime} is this machine's default runtime for new agents. Pick another default first.`,
    );
  }
  if (change.defaultRuntime !== undefined) {
    if (removals.includes(change.defaultRuntime))
      refuse(`${change.defaultRuntime} is being removed, so it cannot be the new default`);
    draft.machine.defaultRuntime = change.defaultRuntime;
  }
  for (const name of removals) delete draft.runtimes[name];

  const left = users.filter(name => !removals.includes(name) && change.switchRuntimes?.[name] === undefined);
  // C10: a runtime on it would have nothing to launch with.
  if (left.length > 0) {
    refuse(
      `${counted(left.length, 'runtime')} still ${left.length === 1 ? 'uses' : 'use'} this login (${listed(left)}). ${switches.length + removals.length === 0 ? `Move ${left.length === 1 ? 'it' : 'them'} to another login first.` : `Switch ${left.length === 1 ? 'it' : 'them'} to another login or remove ${left.length === 1 ? 'it' : 'them'} first.`}`,
    );
  }

  for (const [to, names] of byTarget) {
    consequences.push(
      `${listed(names)} ${names.length === 1 ? 'moves' : 'move'} to login ${to}, starting with it the next time ${names.length === 1 ? 'it launches' : 'they launch'}.`,
    );
  }
  if (removals.length > 0) {
    consequences.push(
      `Removes ${counted(removals.length, 'runtime')}: ${listed(removals)}. Their past sessions stay in history.`,
    );
  }
  if (change.defaultRuntime !== undefined) {
    consequences.push(`${change.defaultRuntime} becomes this machine's default runtime for new agents.`);
  }
  const running = Object.values(facts.runningByRuntime ?? {}).flat();
  if (running.length > 0) {
    consequences.push(
      `${counted(running.length, 'ferret')} ${running.length === 1 ? 'is' : 'are'} running on ${users.length === 1 ? 'that runtime' : 'those runtimes'}. ${running.length === 1 ? 'It keeps' : 'They keep'} running${removals.length === 0 ? '' : ', but restarting one on a removed runtime later needs another runtime'}.`,
    );
  }

  const parts = [
    ...(switches.length === 0
      ? []
      : [`switching ${counted(switches.length, 'runtime')} to ${listed([...byTarget.keys()])}`]),
    ...(removals.length === 0 ? [] : [`removing ${counted(removals.length, 'runtime')}`]),
  ];
  return parts.length === 0 ? `Remove login ${change.id}` : `Remove login ${change.id}, ${listed(parts)}`;
}

/** The five things "What agents may control" names, in the order a summary lists them. */
const AGENT_CONTROL_KINDS: readonly (keyof AgentControl)[] = [
  'terminals',
  'browsers',
  'files',
  'ferretrySettings',
  'pageScripts',
];

/**
 * `machine.settings` (T): a caller always sends all three machine settings together, so this writes
 * only the ones that actually moved and says exactly those in the summary and consequences — a save
 * that touched nothing reads as "nothing changed" rather than repeating agent permissions unasked.
 *
 * `defaultRuntime` needs no cross-reference check of its own: the draft goes through the same
 * {@link AccountModelSchema} parse every other change does ({@link deriveAccountChange}), which
 * already refuses a name that is not an agent runtime on this machine, by name.
 */
function putMachineSettings(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'machine.settings' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const parts: string[] = [];

  if (change.agentPermissions !== model.machine.agentPermissions) {
    draft.machine.agentPermissions = change.agentPermissions;
    parts.push(`agent permissions to ${AGENT_PERMISSION_WORDS[change.agentPermissions]}`);
    // E32: the setting is read at launch, so a running session keeps the mode it started with.
    const running = facts.runningSessions;
    consequences.push(
      running === 0
        ? 'Applies to new sessions.'
        : `Applies to new sessions. ${counted(running, 'running session')} ${running === 1 ? 'keeps' : 'keep'} the old mode (${AGENT_PERMISSION_WORDS[model.machine.agentPermissions]}) until restarted.`,
    );
  }

  const previousDefault = model.machine.defaultRuntime ?? null;
  if (change.defaultRuntime !== previousDefault) {
    if (change.defaultRuntime === null) delete draft.machine.defaultRuntime;
    else draft.machine.defaultRuntime = change.defaultRuntime;
    parts.push(
      change.defaultRuntime === null
        ? 'the default runtime for new agents back to automatic'
        : `the default runtime for new agents to ${change.defaultRuntime}`,
    );
  }

  // A client that predates Ferretry settings or Page scripts leaves them out, and leaves them as they are.
  const agentControl: AgentControl = {
    ...change.agentControl,
    ferretrySettings: change.agentControl.ferretrySettings ?? model.machine.agentControl.ferretrySettings,
    pageScripts: change.agentControl.pageScripts ?? model.machine.agentControl.pageScripts,
  };
  const movedControls = AGENT_CONTROL_KINDS.filter(kind => agentControl[kind] !== model.machine.agentControl[kind]);
  if (movedControls.length > 0) {
    draft.machine.agentControl = agentControl;
    parts.push(
      `what agents may control (${movedControls.map(kind => `${kind} ${agentControl[kind] ? 'on' : 'off'}`).join(', ')})`,
    );
    consequences.push('Applies to an agent’s next action; nothing already running is interrupted.');
  }

  // A client that predates Browser mode leaves it out, and leaves it as it is.
  const browserMode = change.browserMode ?? model.machine.browserMode;
  if (browserMode !== model.machine.browserMode) {
    draft.machine.browserMode = browserMode;
    parts.push(`the browser mode to ${BROWSER_MODE_WORDS[browserMode]}`);
    // Read when the browser starts: closing a running one here would close every agent's pages.
    consequences.push(
      'Applies the next time the browser starts; a browser already running keeps its mode until it stops.',
    );
  }

  // A client that predates Browser proxy leaves it out, and leaves it as it is; `null` turns the proxy off.
  if (change.browserProxy !== undefined) {
    const previous = model.machine.browserProxy ?? null;
    if (JSON.stringify(change.browserProxy) !== JSON.stringify(previous)) {
      if (change.browserProxy === null) delete draft.machine.browserProxy;
      else draft.machine.browserProxy = change.browserProxy;
      parts.push(
        change.browserProxy === null ? 'the browser proxy off' : `the browser proxy to ${change.browserProxy.url}`,
      );
      consequences.push(
        'Applies the next time the browser starts; a browser already running keeps its network route until it stops.',
      );
    }
  }

  // A client that predates Browser ports leaves it out, and leaves it as it is.
  if (change.browserPorts !== undefined) {
    const previous = model.machine.browserPorts;
    if (JSON.stringify(change.browserPorts) !== JSON.stringify(previous)) {
      draft.machine.browserPorts = change.browserPorts;
      parts.push(`the browser ports to ${browserPortsWords(change.browserPorts)}`);
      consequences.push(
        'Applies the next time the browser or the login window starts; a browser already running keeps its ports until it stops.',
      );
    }
  }

  // A client that predates the firewall policy leaves it out, and leaves it as it is.
  if (
    change.browserFirewallFailure !== undefined &&
    change.browserFirewallFailure !== model.machine.browserFirewallFailure
  ) {
    draft.machine.browserFirewallFailure = change.browserFirewallFailure;
    parts.push(`the loopback firewall failure policy to ${change.browserFirewallFailure}`);
    consequences.push('Applies the next time the browser starts; a browser already running is not stopped.');
  }

  // A client that predates Auto-resume leaves it out, and leaves it as it is.
  const autoResume = change.autoResume ?? model.machine.autoResume;
  if (autoResume !== model.machine.autoResume) {
    draft.machine.autoResume = autoResume;
    parts.push(`auto-resume after restart ${autoResume ? 'on' : 'off'}`);
    consequences.push('Applies the next time the daemon starts.');
  }

  // A client that predates Agenda mode leaves it out, and leaves it as it is.
  const agendaMode = change.agendaMode ?? model.machine.agendaMode;
  if (agendaMode !== model.machine.agendaMode) {
    draft.machine.agendaMode = agendaMode;
    parts.push(`agenda mode for new ferrets ${agendaMode ? 'on' : 'off'}`);
    // Recorded on each ferret as it starts: a ferret that exists keeps the switch it has.
    consequences.push('Applies to ferrets started after this; ferrets that already exist keep their own switch.');
  }

  // A client that predates the public usage feed leaves it out, and leaves it as it is.
  const publicUsageFeed = change.publicUsageFeed ?? model.machine.publicUsageFeed;
  if (publicUsageFeed !== model.machine.publicUsageFeed) {
    draft.machine.publicUsageFeed = publicUsageFeed;
    parts.push(`the public usage feed ${publicUsageFeed ? 'on' : 'off'}`);
    consequences.push(
      publicUsageFeed
        ? 'Applies at once: any process on this host, and anything that reaches the daemon, can read quota percentages and account labels at /usage and /metrics without a credential.'
        : 'Applies at once: /usage and /metrics answer as paths the daemon does not have.',
    );
  }

  if (parts.length === 0) return 'Keep machine settings the same';
  return `Set ${parts.join('; ')}`;
}

/** The product's words for each Browser mode (docs/browser-mode.md). */
const BROWSER_MODE_WORDS: Readonly<Record<BrowserMode, string>> = {
  headless: 'Headless',
  window: 'Real window',
};

/** The product's words for each Agent permissions choice (F4). */
const AGENT_PERMISSION_WORDS: Readonly<Record<'auto' | 'skip', string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

/** What removing a runtime does to the sessions on it, as exactly as this daemon knows them. */
function removalConsequence(running: readonly RunningSession[] | undefined): string {
  if (running === undefined)
    return 'Running sessions of it keep going until they end. Its past sessions stay in history.';
  if (running.length === 0) return 'Nothing is running on it. Its past sessions stay in history.';
  return `${counted(running.length, 'ferret')} ${running.length === 1 ? 'is' : 'are'} running on it. ${running.length === 1 ? 'It keeps' : 'They keep'} running, but restarting ${running.length === 1 ? 'it' : 'them'} later needs another runtime. Its past sessions stay in history.`;
}

/**
 * A new name for one runtime, and every place the configuration names it: the default runtime for new
 * agents and each command that runs it. The id stays — `ids.json` moves it to the new name in the same
 * apply — so nothing keyed by id moves, and nothing restarts.
 */
function renameRuntime(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'runtime.rename' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const { name, to } = change;
  const runtime = draft.runtimes[name];
  if (runtime === undefined) return refuse(`no runtime ${name} exists on this machine`);
  if (to === name) refuse(`${name} is already called ${name}.`);
  const commands = new Set(model.advanced.commands.map(command => command.wrapper));
  const references = facts.runtimeReferences ?? {};
  // A name this runtime had before is its own to take back; any other runtime's spelling is not.
  const claimedElsewhere = (candidate: string): boolean => {
    const owner = references[candidate];
    return owner !== undefined && owner !== name;
  };
  assertFreeRuntimeName(
    to,
    candidate => model.runtimes[candidate] !== undefined || commands.has(candidate) || claimedElsewhere(candidate),
    'runtime',
    facts.machineName,
  );
  delete draft.runtimes[name];
  draft.runtimes[to] = runtime;
  if (model.machine.defaultRuntime === name) {
    draft.machine.defaultRuntime = to;
    consequences.push(`${to} stays this machine's default runtime for new agents.`);
  }
  const running = model.advanced.commands.filter(command => command.runtime === name).map(command => command.wrapper);
  if (running.length > 0) {
    (draft.advanced as { commands: { runtime: string }[] }).commands.forEach(command => {
      if (command.runtime === name) command.runtime = to;
    });
    consequences.push(`${listed(running)} ${running.length === 1 ? 'runs' : 'run'} ${to} from now on.`);
  }
  consequences.push(
    'Running ferrets keep working — nothing restarts.',
    `${name} keeps starting it: \`--agent ${name}\` still works.`,
  );
  return `Rename runtime ${name} to ${to}`;
}

function putRuntime(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'runtime.put' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const exists = model.runtimes[change.name] !== undefined;
  if (change.create) {
    const commands = new Set(model.advanced.commands.map(command => command.wrapper));
    assertFreeRuntimeName(
      change.name,
      name => model.runtimes[name] !== undefined || commands.has(name),
      'runtime',
      facts.machineName,
    );
  } else if (!exists) {
    refuse(`no runtime ${change.name} exists on this machine`);
  }
  const credential = model.credentials[change.credential];
  if (credential === undefined) return refuse(`no login ${change.credential} exists on this machine`);
  if (model.profiles[change.profile] === undefined)
    return refuse(`no profile ${change.profile} exists on this machine`);
  // A login that drives both CLIs runs the one asked for, else the one the profile is scoped to.
  const served = credentialHarnesses(credential);
  if (change.harness !== undefined && !served.includes(change.harness)) {
    refuse(
      `${change.credential} does not drive ${HARNESS_DISPLAY_NAMES[change.harness]}: it is a ${HARNESS_DISPLAY_NAMES[credential.harness]} login.`,
    );
  }
  const harness = runtimeHarness(model, change) as HarnessKind;
  // P7: a Claude-only profile never runs on a Codex login, nor the other way round. A profile mixed
  // before P7 existed is refused only when a runtime is moved ONTO it. A login that drives both fits
  // either, unless the runtime was pinned to the other CLI.
  const scope = profileScope(model, change.profile);
  const moving = model.runtimes[change.name]?.profile !== change.profile;
  if (scope.kind === 'scoped' && !scopeFits(scope.scope, harness)) {
    refuse(
      served.length > 1
        ? `Profile ${change.profile} is ${HARNESS_SCOPE_WORDS[scope.scope]} and this runtime runs ${HARNESS_DISPLAY_NAMES[harness]} on ${change.credential}. Run it on the other CLI, or pick a Generic or ${HARNESS_SCOPE_WORDS[harness]} profile.`
        : `Profile ${change.profile} is ${HARNESS_SCOPE_WORDS[scope.scope]} and ${change.credential} is a ${HARNESS_DISPLAY_NAMES[harness]} login. Pick a Generic or ${HARNESS_SCOPE_WORDS[harness]} profile.`,
    );
  }
  if (scope.kind === 'mixed' && moving) refuse(describeScopeConflict(scope, change.profile));
  // P5, E14: a profile with nothing for this login's harness launches nothing of the person's setup.
  const resolved = resolveProfile({ model, profile: change.profile, harness });
  if (resolved.ok && !resolved.resolved.availability.available) {
    refuse(
      `Nothing in profile ${change.profile} applies on ${HARNESS_DISPLAY_NAMES[harness]}. Pick a different profile.`,
    );
  }
  // R4, E15: allowed, but only once the person has seen that it duplicates one.
  const twins = Object.entries(model.runtimes)
    .filter(
      ([name, runtime]) =>
        name !== change.name && runtime.credential === change.credential && runtime.profile === change.profile,
    )
    .map(([name]) => name)
    .toSorted();
  if (twins.length > 0 && change.addAnother !== true) {
    refuse(
      `${listed(twins)} already ${twins.length === 1 ? 'uses' : 'use'} this login and profile. Add another anyway?`,
    );
  }
  if (twins.length > 0)
    consequences.push(`${listed(twins)} already ${twins.length === 1 ? 'uses' : 'use'} this login and profile.`);
  draft.runtimes[change.name] = {
    credential: change.credential,
    profile: change.profile,
    agent: change.agent,
    ...(change.harness === undefined ? {} : { harness: change.harness }),
    ...(model.runtimes[change.name]?.disabled === undefined ? {} : { disabled: model.runtimes[change.name]?.disabled }),
    ...(model.runtimes[change.name]?.compactAt === undefined
      ? {}
      : { compactAt: model.runtimes[change.name]?.compactAt }),
    ...cloneLinkOf(model.runtimes[change.name]),
  };
  // The first agent runtime on a machine becomes its default for new agents (and the Warden's login).
  if (change.create && change.agent && resolveDefaultRuntime(model) === undefined) {
    draft.machine.defaultRuntime = change.name;
    consequences.push(`${change.name} is now this machine's default runtime for new agents.`);
  }
  if (exists) consequences.push('Running sessions keep the old setup until restarted.');
  return exists ? `Change runtime ${change.name}` : `Add runtime ${change.name}`;
}

function putProfile(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'profile.put' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const exists = model.profiles[change.name] !== undefined;
  if (change.create && exists) {
    refuse(
      `${change.name} is already a profile on ${facts.machineName}. Use ${freeName(change.name, name => model.profiles[name] !== undefined)}?`,
    );
  }
  if (!change.create && !exists) refuse(`no profile ${change.name} exists on this machine`);
  const layers = layersRefusal(model, change.name, change.layers);
  if (layers !== undefined) refuse(layers);
  const before = model.profiles[change.name];
  draft.profiles[change.name] = {
    layers: [...change.layers],
    ...(before?.compactAt === undefined ? {} : { compactAt: before.compactAt }),
    ...cloneLinkOf(before),
  };
  if (exists) {
    const consequence = editConsequence(profileUsage(model, change.name));
    if (consequence !== undefined) consequences.push(consequence);
  }
  return exists ? `Change the layers of profile ${change.name}` : `Add profile ${change.name}`;
}

function removeProfile(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'profile.remove' }>,
  consequences: string[],
): string {
  if (model.profiles[change.name] === undefined) refuse(`no profile ${change.name} exists on this machine`);
  // P6, E21: a base is removed from the profiles built on it first; they would lose what it gave them.
  const usage = profileUsage(model, change.name);
  if (usage.direct.length > 0) {
    if (change.removeFromProfiles !== true) {
      refuse(
        `Profile ${change.name} is a base for ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
      );
    }
    const base = `profile/${change.name}`;
    for (const profile of usage.direct) {
      const layers = (draft.profiles[profile] as { layers: string[] }).layers.filter(layer => layer !== base);
      if (layers.length === 0) {
        refuse(
          `removing profile ${change.name} would leave profile ${profile} with no layers; add another layer to it first`,
        );
      }
      (draft.profiles[profile] as { layers: string[] }).layers = layers;
    }
    const behind = usage.runtimes.filter(runtime => !runtimesUsingProfile(model, change.name).includes(runtime));
    consequences.push(
      `Removes it from ${listed(usage.direct)}${behind.length === 0 ? '' : `, which changes ${counted(behind.length, 'runtime')}`}. Running sessions keep the old version until restarted.`,
    );
  }
  const runtimes = runtimesUsingProfile(model, change.name);
  if (runtimes.length > 0) {
    const target = change.switchRuntimesTo;
    if (target === undefined) {
      refuse(
        `${counted(runtimes.length, 'runtime')} ${runtimes.length === 1 ? 'uses' : 'use'} profile ${change.name} (${listed(runtimes)}). Pick the profile ${runtimes.length === 1 ? 'it switches' : 'they switch'} to.`,
      );
    }
    if (target === change.name) refuse(`pick a profile other than ${change.name} to switch to`);
    if (model.profiles[target as string] === undefined) refuse(`no profile ${target} exists on this machine`);
    for (const runtime of runtimes) (draft.runtimes[runtime] as Record<string, unknown>).profile = target;
    consequences.push(`Switches ${counted(runtimes.length, 'runtime')} to ${target}.`);
  }
  delete draft.profiles[change.name];
  consequences.push('Its components stay saved.');
  return runtimes.length > 0
    ? `Switch ${counted(runtimes.length, 'runtime')} and delete profile ${change.name}`
    : `Delete profile ${change.name}`;
}

function putComponent(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'component.put' }>,
  facts: AccountChangeFacts,
  files: AccountComponentFile[],
  consequences: string[],
): string {
  const kind = change.component.kind;
  const existing = model.components[kind][change.name] as Record<string, unknown> | undefined;
  const word = KIND_WORDS[kind];
  if (change.create && existing !== undefined) {
    refuse(
      `${change.name} is already a ${word} on ${facts.machineName}. Use ${freeName(change.name, name => model.components[kind][name] !== undefined)}?`,
    );
  }
  if (!change.create && existing === undefined) refuse(`no ${word} ${change.name} exists on this machine`);
  if (change.content !== undefined && componentExtension(change.component) === undefined) {
    refuse(`a ${word} has no text to save; send its fields instead`);
  }
  if (change.component.kind === 'settings' && change.component.entries !== undefined && change.content !== undefined) {
    refuse(`send settings ${change.name} as its text or as its entries, not both`);
  }
  const built = componentOf(
    change.name,
    change.component,
    change.content,
    existing,
    facts.settingsBodies?.[change.name],
  );
  draft.components[kind][change.name] = built.component;
  if (built.file !== undefined) files.push(built.file);
  if (existing !== undefined) {
    // E20: where the edit lands, before the person presses Save for all.
    const consequence = editConsequence(componentUsage(model, `${kind}/${change.name}`));
    if (consequence !== undefined) consequences.push(consequence);
  }
  return existing === undefined ? `Add ${word} ${change.name}` : `Change ${word} ${change.name}`;
}

function removeComponent(
  model: AccountModel,
  draft: Draft,
  change: Extract<PlanChange, { kind: 'component.remove' }>,
  consequences: string[],
): string {
  const kind = change.componentKind;
  const word = KIND_WORDS[kind];
  if (model.components[kind][change.name] === undefined) refuse(`no ${word} ${change.name} exists on this machine`);
  const reference = `${kind}/${change.name}` as const;
  const usage = componentUsage(model, reference);
  if (usage.direct.length > 0) {
    // K7, E21: blocked while a profile has it as a layer, naming those profiles and the runtimes behind them.
    if (change.removeFromProfiles !== true) {
      const behind = usage.runtimes.length === 0 ? '' : ` (used by ${listed(usage.runtimes)})`;
      refuse(
        `${word.charAt(0).toUpperCase()}${word.slice(1)} ${change.name} is a layer in ${listed(usage.direct)}${behind}. Remove it from those first.`,
      );
    }
    for (const profile of usage.direct) {
      const layers = (draft.profiles[profile] as { layers: string[] }).layers.filter(layer => layer !== reference);
      if (layers.length === 0) {
        refuse(
          `removing ${word} ${change.name} would leave profile ${profile} with no layers; add another layer to it first`,
        );
      }
      (draft.profiles[profile] as { layers: string[] }).layers = layers;
    }
    consequences.push(
      `Removes it from ${listed(usage.direct)}${usage.runtimes.length === 0 ? '' : `, which changes ${counted(usage.runtimes.length, 'runtime')}`}. Running sessions keep the old version until restarted.`,
    );
  }
  delete draft.components[kind][change.name];
  return `Delete ${word} ${change.name}`;
}

/** The `disabled:` block a disable change writes: only what the caller said. */
function disabledBlock(change: { readonly reason?: string | undefined; readonly until?: string | undefined }): {
  readonly reason?: string;
  readonly until?: string;
} {
  return {
    ...(change.reason === undefined ? {} : { reason: change.reason }),
    ...(change.until === undefined ? {} : { until: change.until }),
  };
}

/** The product's words for a Browser ports setting (docs/config-files.md). */
function browserPortsWords(setting: BrowserPortsSetting): string {
  if (setting === 'random') return 'random';
  if (setting === 'per-user') return 'per-user (derived from the user id)';
  return `cdp ${setting.cdp}, relay ${setting.relay}, vnc ${setting.vnc}`;
}
