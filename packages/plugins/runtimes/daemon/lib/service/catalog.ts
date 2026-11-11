/**
 * Who uses what in a machine's account model: the one reading of "used by" that the catalogue shows
 * and every change refuses or warns with (K1, K7, P6, E20, E21), so a list and the refusal of a delete
 * can never count differently.
 *
 * Below the usage helpers are the catalogue's projections — what the machine, component, profile and
 * runtime reads answer — so the layering module decides what a stack IS and this only says it in the
 * product's words (§4.2).
 *
 * Pure.
 */
import {
  type AccountModel,
  type ComponentKind,
  type LayerReferenceText,
  parseLayerReference,
  resolveDefaultRuntime,
  wouldIncludeItself,
} from '../account/schema.ts';
import { applyFixedLayer, type FixedEntry, fixedLayerFor } from '../account/fixed-layer.ts';
import {
  COMPONENT_KIND_WORDS,
  componentScope,
  describeScopeConflict,
  layersScope,
  layerWords,
  type ProfileScope,
  profileScope,
  runtimeHarness,
} from '../account/scope.ts';
import {
  type Conflict,
  describeConflict,
  type FlatLayer,
  flattenProfile,
  HARNESS_DISPLAY_NAMES,
  type PartialSupport,
  type ResolvedProfile,
  resolveProfile,
  type SkippedLayer,
} from '../account/layering.ts';
import { componentPartialSupport, describePartialSupport } from '../account/adapt.ts';
import { freeName } from '../account/import.ts';
import { findFlagSecrets, looksSecret, rawTextHoldsSecret, SECRET_TOKEN_SOURCE } from '@ferretry/std/credential-words';
import { hooksDocumentRefusedLines } from './hooks-document-net.ts';
import type { HarnessKind } from '../manifest.ts';
import { runtimeDisable, type BudgetHolds } from '../account/disabled-runtime.ts';
import type { SettingsObject } from '../settings.ts';
import type {
  AutoResumeSummary,
  CatalogAct,
  CatalogFormat,
  CommandWord,
  ComponentCatalog,
  ComponentContent,
  ComponentView,
  ComponentDetail,
  CredentialStatusWord,
  EnvEntry,
  FixedLayerView,
  LayerConflict,
  LayeredProfileCatalog,
  MachineAuthority,
  MachineView,
  ProfileDraftRequest,
  ProfileDraftView,
  ProfileScope as ProfileScopeView,
  RuntimeCatalog,
  RuntimeModelSet,
  RuntimeModels,
  SettingsEntry,
  StackView,
} from '../../../contract/index.ts';
import { MIN_SECRET_VALUE_LENGTH } from '@ferretry/core-vault/contract';
import { WITHHELD_WORDS_TEXT } from '../../../contract/index.ts';
import { claudeFastSupport, harnessKey, scopeKey } from './foreign.ts';
import { loginModelCatalog, type ModelCatalogSources } from '../models/catalog.ts';
import { runtimeModels } from '../models/runtime.ts';
import { runtimeDisabledView } from './disabled-view.ts';
import { resolvedEntries } from './resolved-view.ts';
import {
  commandWithheld,
  commandWordsOf,
  shownLine,
  shownWordsEtag,
  valueSaid,
  valueWithheld,
  writtenWithheld,
} from './command-line.ts';

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Who uses one component or profile. */
export interface CatalogUsage {
  /** Profiles that have it as one of their own layers. */
  readonly direct: readonly string[];
  /** Profiles whose stack reaches it, directly or through a base. */
  readonly profiles: readonly string[];
  /** Runtimes whose profile reaches it. */
  readonly runtimes: readonly string[];
}

const runtimesOn = (model: AccountModel, profiles: ReadonlySet<string>): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => profiles.has(runtime.profile))
    .map(([name]) => name)
    .toSorted(byName);

/** Who uses the component `reference` (`<kind>/<name>`). */
export function componentUsage(model: AccountModel, reference: LayerReferenceText): CatalogUsage {
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(reference))
    .map(([name]) => name)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(name => {
      const flat = flattenProfile(model, name);
      return flat.ok && flat.layers.some(layer => layer.reference === reference);
    })
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set(profiles)) };
}

/**
 * Who uses the profile `name`: the profiles that name it as a base, the profiles whose stack reaches
 * it, and the runtimes on any of those or on it.
 */
export function profileUsage(model: AccountModel, name: string): CatalogUsage {
  const base = `profile/${name}`;
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(base as LayerReferenceText))
    .map(([other]) => other)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(other => other !== name && wouldIncludeItself(model.profiles, name, other))
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set([name, ...profiles])) };
}

/** The runtimes that name `profile` themselves, which a delete must move (P6). */
export const runtimesUsingProfile = (model: AccountModel, profile: string): readonly string[] =>
  runtimesOn(model, new Set([profile]));

/** The runtimes on one credential (C10). */
export const runtimesUsingCredential = (model: AccountModel, credential: string): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => runtime.credential === credential)
    .map(([name]) => name)
    .toSorted(byName);

/** "1 profile", "3 runtimes". */
export const counted = (count: number, singular: string, pluralWord = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralWord}`;

/** "a, b and c". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

/** E20: what an edit says about where it lands, or nothing when nobody else uses it. */
export function editConsequence(usage: CatalogUsage): string | undefined {
  if (usage.profiles.length === 0 && usage.runtimes.length === 0) return undefined;
  return `Used by ${counted(usage.profiles.length, 'profile')} and ${counted(usage.runtimes.length, 'runtime')}. Saving changes it everywhere. Running sessions keep the old version until restarted.`;
}

// ── The catalogue projections ────────────────────────────────────────────────────────────────────
//
// What `GET /v1/fleet/machine`, `/components`, `/profiles` and `/runtimes` answer, as values: the
// layering module decides what a stack IS; these only say it in the product's words (§4.2).

/** The facts a projection reads that the configuration does not hold. */
export interface CatalogFacts {
  readonly format: CatalogFormat;
  readonly machineName: string;
  /** The command each harness resolves to on this machine, `undefined` when it is not installed. */
  readonly tools: Readonly<Record<HarnessKind, string | undefined>>;
  readonly runningSessions: number;
  /** Each runtime's stable id from `ids.json`, by name. A runtime the last apply never published has none. */
  readonly runtimeIds?: Readonly<Record<string, string>>;
  /** What the last apply left as it was, by runtime id: paths inside that runtime's folder (kept in memory until the next apply). */
  readonly skipped?: Readonly<Record<string, readonly string[]>>;
  /** Each settings component's parsed file, by component name, so conflicts are real ones. */
  readonly settingsBodies?: Readonly<Record<string, SettingsObject>>;
  /** Instructions text and skill frontmatter, for partial support (K5). */
  readonly instructionBodies?: Readonly<Record<string, string>>;
  readonly skillFrontmatter?: Readonly<Record<string, readonly string[]>>;
  /** Each hooks component's file text, for the edit screen and E30. */
  readonly hooksTexts?: Readonly<Record<string, string>>;
  /** This machine's user home: a path under it is not one to check (E30). */
  readonly userHome: string;
  /** MCP commands this machine does not have (K6, E8). */
  readonly missingCommands?: ReadonlySet<string>;
  /** Each credential's status word, from the credentials surface's own reading. */
  readonly credentialStatus?: Readonly<Record<string, CredentialStatusWord>>;
  /** Whether the installed Claude accepts Auto mode (O4). Measured on the pinned version; nothing is launched to find out. */
  readonly acceptsAutoPermissionMode: boolean;
  /** The model catalogs and presets in effect (docs/model-catalog.md); absent, runtimes show their model set only. */
  readonly modelCatalogs?: ModelCatalogSources;
  /** What the last auto-resume pass did, or `null`/absent when none has run. */
  readonly lastAutoResume?: AutoResumeSummary | null;
  /** The instant (ms) a `disabled.until` is read against; absent, no switch has expired. */
  readonly now?: number;
  /** The logins their spend budget holds now (docs/budgets.md); absent, none. */
  readonly budgetHolds?: BudgetHolds;
}

const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

const act = (reason: string | undefined): CatalogAct =>
  reason === undefined ? { available: true } : { available: false, reason };

/** `GET /v1/fleet/machine`, with what the caller asking may do to it. */
export function machineView(model: AccountModel, facts: CatalogFacts, authority: MachineAuthority): MachineView {
  const runtimeCount = Object.keys(model.runtimes).length;
  return {
    name: facts.machineName,
    format: facts.format,
    setUp: runtimeCount > 0,
    agentPermissions: model.machine.agentPermissions,
    defaultRuntime: resolveDefaultRuntime(model) ?? null,
    agentControl: { ...model.machine.agentControl },
    browserMode: model.machine.browserMode,
    browserProxy: model.machine.browserProxy ?? null,
    browserPorts: model.machine.browserPorts,
    browserFirewallFailure: model.machine.browserFirewallFailure,
    autoResume: model.machine.autoResume,
    agendaMode: model.machine.agendaMode,
    publicUsageFeed: model.machine.publicUsageFeed,
    lastAutoResume: facts.lastAutoResume ?? null,
    tools: HARNESSES.map(harness => {
      const command = facts.tools[harness];
      return {
        harness: harnessKey(harness),
        label: HARNESS_DISPLAY_NAMES[harness],
        installed: command !== undefined,
        ...(command === undefined ? {} : { command }),
      };
    }),
    runtimeCount,
    runningSessions: facts.runningSessions,
    authority,
  };
}

/** The six kinds, in the order the Components section lists them, with their one-line description. */
const KIND_GROUPS: readonly { readonly kind: ComponentKind; readonly label: string; readonly description: string }[] = [
  { kind: 'instructions', label: 'Instructions', description: 'Guidance every session reads first.' },
  { kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.' },
  { kind: 'skills', label: 'Skills', description: 'Named abilities a session can use.' },
  { kind: 'settings', label: 'Settings', description: 'Flags, environment and options for one tool.' },
  { kind: 'hooks', label: 'Hooks', description: 'Commands that run at points in a session, for one tool.' },
  { kind: 'modelSets', label: 'Model sets', description: 'The models a runtime offers, and its default.' },
];

/** One environment entry as it may travel: a value only when it is not a secret (K4). */
const envEntries = (env: Readonly<Record<string, string>> | undefined): EnvEntry[] =>
  Object.entries(env ?? {})
    .toSorted(([left], [right]) => byName(left, right))
    .map(([name, value]) =>
      looksSecret(name, value) || valueWithheld(name, value) ? { name, hidden: true as const } : { name, value },
    );

/**
 * A component's launch flags or MCP arguments as they may travel (rulings #39, #40): each word through the one
 * command-line rule (`./command-line.ts`), a word that carries a credential as `{ shown, hidden: true }`, and the
 * etag an edit that keeps one sends back. For EVERY caller, the edit form's owner included: the form keeps a hidden
 * word by its position (`{ keep: true, at }`) and never holds its value.
 */
function commandWords(
  words: unknown,
  first: unknown,
):
  | { readonly words: CommandWord[]; readonly etag: string; readonly withheld?: undefined }
  | { readonly withheld: true }
  | undefined {
  if (!Array.isArray(words)) return undefined;
  // The word before the arguments is the last word of the command: `srv --token` then `v` is one pair (W reads the blanks).
  const line = shownLine(words as string[], typeof first === 'string' ? commandWordsOf(first).at(-1) : undefined);
  // THE NET: a word the write rule still refuses once the cutter has had its say withholds the WHOLE list, never a part.
  if (line.withheld) return { withheld: true };
  return {
    words: line.words.map(word => (word.hidden ? { shown: word.text, hidden: true as const } : word.text)),
    etag: shownWordsEtag(line.words),
  };
}

function componentDetail(kind: ComponentKind, component: Record<string, unknown>): ComponentDetail {
  const env = component.env as Readonly<Record<string, string>> | undefined;
  const text = (key: string) => (typeof component[key] === 'string' ? { [key]: component[key] as string } : {});
  switch (kind) {
    case 'instructions':
      return { kind, file: typeof component.file === 'string' ? component.file : 'config/instructions' };
    case 'mcp': {
      const args = commandWords(component.args, component.command);
      // THE NET, for the text shown as written: withheld whole, never a part of it.
      const commandHeld = typeof component.command === 'string' && commandWithheld(component.command);
      const urlHeld = typeof component.url === 'string' && writtenWithheld('url', component.url);
      return {
        kind,
        ...(commandHeld ? { commandWithheld: true as const } : text('command')),
        ...(args === undefined
          ? {}
          : args.withheld
            ? { argsWithheld: true as const }
            : { args: args.words, argsEtag: args.etag }),
        ...(urlHeld ? { urlWithheld: true as const } : text('url')),
        ...(component.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
        env: envEntries(env),
      };
    }
    case 'skills':
      return { kind, items: [...(component.items as string[])] };
    case 'settings': {
      const flags = commandWords(component.flags, undefined);
      return {
        kind,
        ...text('file'),
        ...(flags === undefined
          ? {}
          : flags.withheld
            ? { flagsWithheld: true as const }
            : { flags: flags.words, flagsEtag: flags.etag }),
        env: envEntries(env),
      };
    }
    case 'hooks':
      return { kind, ...text('file'), ...text('directory') };
    default:
      return { kind, models: [...(component.models as string[])], default: component.default as string };
  }
}

/** The partial-support table for this machine's components, from the bodies the caller read. */
const partialSupportOf = (model: AccountModel, facts: CatalogFacts): readonly PartialSupport[] =>
  componentPartialSupport({
    components: model.components,
    ...(facts.instructionBodies === undefined ? {} : { instructionBodies: facts.instructionBodies }),
    ...(facts.skillFrontmatter === undefined ? {} : { skillFrontmatter: facts.skillFrontmatter }),
  });

// ── Component content ────────────────────────────────────────────────────────────────────────────
//
// What a component's file says, for the edit screen: instructions and hooks as text, settings as
// dotted entries. Every value `looksSecret` flags is cut out before it leaves, the same rule the
// environment rows follow (K4), so a credential pasted into a file never reaches a browser.

/** What a hidden value is replaced by in a component's text. */
const HIDDEN_TEXT = '‹hidden›';

/**
 * `NAME=value`, `name: value`, `"name": "value"` — a value with the name that says what it is, on ONE line (a
 * name at the end of a line never takes the next line's text, so `db:⏎  pass: x` reads `pass: x`).
 *
 * LINEAR: a name starts only where a run of name characters starts (the look-behind), after any leading digits,
 * dots and dashes (`9TOKEN=…`, `-=TOKEN=…`), so a long run with no separator after it is scanned once, not once
 * from every character in it. The value is only LOOKED AT (a capped look-ahead) and consumed once it is hidden, so a
 * value that is no secret, or a hidden one that is a name with its separator (`auth: KEY="x"`), is searched for a name
 * of its own (`Q= apikey:x`).
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([0-9.-]*)([A-Za-z_][A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*["']?)(?=([^\s"'`,;)}\]]{1,1024}))/gu;
const VALUE_RUN = /[^\s"'`,;)}\]]+/uy;

/** One bare word of text, for a value whose own shape says it is a token. */
const WORD = /[^\s"'`,;()[\]{}<>]+/gu;
/**
 * A private-key block (its header, the base64 body and its footer when there is one) and any well-known token
 * ({@link SECRET_TOKEN_SOURCE}), wherever either stands: no name, separator or word boundary is needed. Every
 * part is a linear class, so a long run of one costs a single pass. A key's body runs over line breaks written as
 * escapes too, however many times escaped (`\n`, `\r`: a service account's JSON; `\\n`: that JSON inside a JSON
 * string), and over a word an earlier pass hid already (a body line that starts the way a token does, `eyJ…`,
 * `AIza…`): each of the three starts with a character no other one does, so the body stays one linear pass.
 */
const PRIVATE_KEY_HEADER_SOURCE = '-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----';
const PRIVATE_KEY_SOURCE = `${PRIVATE_KEY_HEADER_SOURCE}(?:[A-Za-z0-9+/=\\s]|\\\\+[nr]|${HIDDEN_TEXT})*(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?`;
const CONTEXT_FREE_SECRET = new RegExp(`${PRIVATE_KEY_SOURCE}|${SECRET_TOKEN_SOURCE}`, 'gu');
/**
 * A private-key block alone, and its header where it starts: what a name's reading never cuts into, so the key is
 * cut whole, header to footer, by {@link CONTEXT_FREE_SECRET} (a cut that took its header would leave its body showing).
 */
const PRIVATE_KEY = new RegExp(PRIVATE_KEY_SOURCE, 'gu');
const PRIVATE_KEY_HEADER = new RegExp(PRIVATE_KEY_HEADER_SOURCE, 'uy');
const PRIVATE_KEY_START = '-----BEGIN';

/** A line that ends in a name and its separator (`password =`), or opens a block value (`password: |`, `token: >-`). */
const OPENS_VALUE = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=]([ \t]*[|>][-+0-9]*)?[ \t]*$/u;
/** A line that ends in a name and nothing else, for a separator that starts the next line (`PASSWORD⏎= x`). */
const NAME_ENDS = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/u;
const STARTS_WITH_SEPARATOR = /^[ \t]*[:=][ \t]*/u;
const BLOCK_INDICATOR = /^[|>][-+0-9]*$/u;
/** A block indicator alone, or with a comment after it (`|`, `>-`, `| # note`): what opens a block on a line of its own. */
const BLOCK_OPENER = /^[|>][-+0-9]*(?:[ \t]+#.*)?$/u;
/** A line that opens a block value and comments on it (`password: | # note`). */
const OPENS_COMMENTED_BLOCK = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]*[|>][-+0-9]*[ \t]+#.*$/u;
/** A line that ends in a name, its separator and a comment (`password: # note`): its value is on a line after it. */
const OPENS_COMMENTED_VALUE = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]+#.*$/u;
/** A line that is a comment and nothing else (`# note`, `  # note`). */
const COMMENT_LINE = /^[ \t]*#/u;
/**
 * YAML node properties — a tag (`!vault`, `!!str`, `!<tag:yaml.org,2002:str>`) and an anchor (`&pw`), one or both, in
 * either order — before a value or a block indicator (`password: !vault |`, `password: &pw !!str fake`). Each is a run
 * of at most 128 characters with no space in it, and a space follows each, so a long run costs a bounded look. An
 * anchor has a name (a lone `&` is no anchor: `Q=& value`); a lone `!` is a tag.
 */
const PROPERTY = '(?:!|&(?=\\S))\\S{0,128}';
/** Node properties at the head of a value, the space after them included. */
const PROPERTIES = new RegExp(`^[ \\t]*${PROPERTY}(?:[ \\t]+${PROPERTY})?(?:[ \\t]+|$)`, 'u');
/** The same, standing where a name's separator ends, and an opening quote after them when there is one. */
const PROPERTIES_AT = new RegExp(`(?:${PROPERTY}[ \\t]+){1,2}["']?`, 'uy');
/**
 * A line that ends in a name, its separator and node properties, with or without a block indicator after them, and
 * with or without a comment after those (`password: !vault |`, `password: &pw`, `password: &pw # note`): what follows
 * the separator is group 2.
 */
const OPENS_AFTER_PROPERTIES = new RegExp(
  `(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \\t]*[:=]([ \\t]*${PROPERTY}(?:[ \\t]+${PROPERTY})?(?:[ \\t]+[|>][-+0-9]*)?(?:[ \\t]+#.*)?[ \\t]*)$`,
  'u',
);
/** A value as {@link ASSIGNMENT} looks at it, read where node properties end. */
const VALUE_LOOK = /[^\s"'`,;)}\]]{1,1024}/uy;
const LINE_BREAKS = /(\r\n|\r|\n)/u;
const FIRST_VALUE = /^([ \t]*["']?)([^\s"'`,;)}\]]*[A-Za-z0-9][^\s"'`,;)}\]]*)/u;
/** A line that is a key of its own (`login_page: x`), and so is not the value of the name above it. */
const KEY_LINE = /^[ \t]*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?[ \t]*:(?:[ \t]|$)/u;
/** A name and its separator as {@link ASSIGNMENT} reads them, for one line at a time. */
const NAME_IN_LINE = new RegExp(ASSIGNMENT.source, 'gu');
/** What ends a value as {@link ASSIGNMENT} reads it. */
const VALUE_END = /[\s"'`,;)}\]]/u;
/** A line that is an assignment of its own (`NAME=value`), or that holds a mapping's `:` (`x: y`, `key:`). */
const ASSIGNS = /^[ \t]*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?[ \t]*=/u;
const MAPS = /:(?:[ \t]|$)/u;
/** What a continued value never starts with: a comment (`# note`), or node properties (`!!binary`, `&pw`). */
const NO_VALUE_HEAD = /^[#!&]/u;
/**
 * A value that only points at one (`$HOME`, `${TOKEN}`, `${secret:TOKEN}`), whole up to the next space. A
 * `${NAME-default}` is no pointer: its default is a value, read as the value of NAME ({@link redactExpansions}).
 */
const POINTER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{(?:secret:)?[A-Za-z_][A-Za-z0-9_.]*\})$/u;
/**
 * `${NAME<op>default}` with op `:-` `-` `:=` `=` `:+` `+` `:?` `?`: the default is read as the value of NAME. Only
 * LOOKED AT here (a capped look-ahead); the whole default run is consumed once it is hidden.
 */
const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_.]*):?[-=+?]["']?(?=([^}\s"'`]{1,1024}))/gu;
const DEFAULT_RUN = /[^}\s"'`]+/uy;
const MAX_POINTER = 256;
/** A value that only a name which announces a secret hides: the block under any other name is no secret's. */
const BLOCK_PROBE = 'x'.repeat(MIN_SECRET_VALUE_LENGTH);
/** What ASSIGNMENT leaves out of a name too: `9TOKEN` is the name `TOKEN`. */
const LEADING_DIGITS = /^[0-9.-]+/u;
/** The separator that a value carries when a line break comes between it and its name (`ghp_x⏎=ghp_y`). */
const LEADING_SEPARATORS = /^[=:&?|/$@]+/u;
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Whether the value found at `start` of `text` is the start of a pointer (`${secret:TOKEN}`), not a secret. */
function isPointer(text: string, start: number): boolean {
  const word = /^\S+/u.exec(text.slice(start, start + MAX_POINTER + 1))?.[0] ?? '';
  return word.length <= MAX_POINTER && POINTER.test(word);
}

const ALPHANUMERIC = /[A-Za-z0-9]/u;
const DIGIT = /[0-9]/u;

/**
 * Whether a match of {@link CONTEXT_FREE_SECRET} is a secret and not a word that merely ends the way a token starts
 * (`task-plan-ended`, `risk-assessment-notes`, `vosk-model-small-en-us-0`): a private-key block always is; a token is
 * one only when no letter or digit stands before it and its body holds a digit. Decided on the match, because a
 * look-behind or look-ahead in the pattern is quadratic on `sk-sk-sk-…`.
 */
function isContextFreeSecret(match: string, offset: number, whole: string): boolean {
  if (match.startsWith('-----BEGIN')) return true;
  return !ALPHANUMERIC.test(whole.charAt(offset - 1)) && DIGIT.test(match);
}

/** Where a name reads its value: the line it is on and how far in, and whether node properties come first. */
interface Reading {
  readonly name: string;
  readonly line: number;
  readonly from: number;
  /** The value stands after node properties at `from` (`!!str fake`), which are skipped when it is read. */
  readonly properties?: true;
}

/** A block scalar a name opens: the line its indicator stands on. */
interface Block {
  readonly name: string;
  readonly line: number;
}

/**
 * Where the values of a name that ends its line are. The name ends the line itself (`password =`, `password: |`),
 * or stands alone with its separator starting the next line (`PASSWORD⏎= x`, `PASSWORD⏎= |`).
 *
 * `value` is the value it reads on one line, as it always did: the line after it (`password:⏎x`), the separator's
 * line (`PASSWORD⏎= x`) or the line after a separator alone (`PASSWORD⏎=⏎x`). `blocks` are the block scalars it
 * opens, each at the line its indicator stands on: the name's own (`password: |`), the separator's line after it
 * (`PASSWORD⏎= |`), or a line of its own after either (`password:⏎  |`, `PASSWORD⏎=⏎|`). A value that is only an
 * indicator, with or without a comment, opens a block as well, and is still read as the value it always was, so a
 * line that opens a block hides at least what it always hid. A comment may follow the indicator on the name's own
 * line (`password: | # note`); that block is read beside any other reading of the line, so a name the comment ends
 * in (`password: | # see note:`) keeps the value it always had.
 *
 * YAML node properties (`!vault`, `!!str`, `&pw`) may stand where a value or an indicator would: on the name's own
 * line (`password: !vault |`, `password: &pw⏎  fake`) or at the head of the value it reads (`PASSWORD⏎= !!str fake`,
 * `password:⏎  !!binary |`). Then the block they open is read, or the value after them (`properties`), or — when
 * they end the line — the value on the next line, beside every reading above, which stays as it was.
 *
 * A comment may stand between a name and its value (`password: # note⏎  fake`, `password:⏎  # note⏎  fake`,
 * `password: &pw # note⏎  fake`, `password: # note⏎  |⏎    fake`): the value, block or node properties on the first
 * line after it that is neither blank nor a comment are read beside the reading that met the comment, which stays as
 * it was. A line that is a comment itself names nothing past comments (a name in it is no key), so a run of comment
 * lines is passed over once, not once from each.
 *
 * `readings` are read only under a name that announces a secret, as a block is.
 */
function opening(
  parts: readonly string[],
  index: number,
): { value?: Reading; blocks: readonly Block[]; readings: readonly Reading[] } {
  const next = (after: number): number => {
    let at = after + 2;
    while (at < parts.length && (parts[at] ?? '').trim() === '') at += 2;
    return at;
  };
  const line = parts[index] ?? '';
  const inComment = COMMENT_LINE.test(line);
  /** The line after `at` that a value is read on: the next that is neither blank nor (past a name) a comment. */
  const valueLine = (at: number): number => {
    let to = next(at);
    while (!inComment && to < parts.length && COMMENT_LINE.test(parts[to] ?? '')) to = next(to);
    return to;
  };
  const blocks: Block[] = [];
  const readings: Reading[] = [];
  let value: Reading | undefined;
  const opens = OPENS_VALUE.exec(line);
  const opened = opens?.[1]?.replace(LEADING_DIGITS, '');
  if (opened) {
    if (opens?.[2] === undefined) value = { name: opened, line: next(index), from: 0 };
    else blocks.push({ name: opened, line: index });
  } else {
    const alone = NAME_ENDS.exec(line)?.[1]?.replace(LEADING_DIGITS, '');
    const at = next(index);
    const separator = alone ? STARTS_WITH_SEPARATOR.exec(parts[at] ?? '') : null;
    if (alone && separator) {
      const rest = (parts[at] ?? '').slice(separator[0].length);
      if (rest.trim() === '') value = { name: alone, line: next(at), from: 0 };
      else if (BLOCK_INDICATOR.test(rest.trim())) blocks.push({ name: alone, line: at });
      else value = { name: alone, line: at, from: separator[0].length };
    }
  }
  if (value && BLOCK_OPENER.test((parts[value.line] ?? '').slice(value.from).trim())) {
    blocks.push({ name: value.name, line: value.line });
  }
  const commented = OPENS_COMMENTED_BLOCK.exec(line)?.[1]?.replace(LEADING_DIGITS, '');
  if (commented) blocks.push({ name: commented, line: index });
  /** What `name` reads on the line a value is read on after line `at`: the block opened there, or the value. */
  const below = (name: string, at: number): void => {
    const to = valueLine(at);
    if (BLOCK_OPENER.test((parts[to] ?? '').trim())) blocks.push({ name, line: to });
    else readings.push({ name, line: to, from: 0 });
  };
  /**
   * What node properties at `from` of line `at` lead to: the block they open, the value after them, or — when they
   * end the line, a comment after them or not — what is below them.
   */
  const afterProperties = (name: string, at: number, from: number): void => {
    const rest = (parts[at] ?? '').slice(from);
    const found = PROPERTIES.exec(rest);
    if (found === null) return;
    const after = rest.slice(found[0].length).trim();
    if (BLOCK_OPENER.test(after)) blocks.push({ name, line: at });
    else if (after === '' || after.startsWith('#')) below(name, at);
    else readings.push({ name, line: at, from, properties: true });
  };
  /** What `name` reads past a comment that ends line `at`: what is below it, and node properties at its head. */
  const pastComment = (name: string, at: number): void => {
    afterProperties(name, valueLine(at), 0);
    below(name, at);
  };
  if (value) afterProperties(value.name, value.line, value.from);
  const tagged = OPENS_AFTER_PROPERTIES.exec(line);
  const named = tagged?.[1]?.replace(LEADING_DIGITS, '');
  if (named) afterProperties(named, index, line.length - (tagged?.[2]?.length ?? 0));
  if (!inComment) {
    if (value && commentsFrom(parts[value.line] ?? '', value.from)) pastComment(value.name, value.line);
    const noted = OPENS_COMMENTED_VALUE.exec(line)?.[1]?.replace(LEADING_DIGITS, '');
    if (noted) pastComment(noted, index);
  }
  return value === undefined ? { blocks, readings } : { value, blocks, readings };
}

/** Whether `line` holds a comment and nothing else from `from` on: a `#` at the head of the line, or after a space. */
function commentsFrom(line: string, from: number): boolean {
  const at = from + indentOf(line.slice(from));
  return line.charAt(at) === '#' && (at === 0 || line.charAt(at - 1) === ' ' || line.charAt(at - 1) === '\t');
}

/**
 * 5.0 (#36, r6): the last line of a value that the lines after its name's line continue, or `index` when none does.
 * YAML reads a line deeper than a key as more of the plain value that ends the key's line (`password: fake⏎  more` is
 * `fake more`); today shows it. Read only after a value that is hidden — one {@link ASSIGNMENT} reads, under a name
 * that announces a secret, with nothing but node properties between them (`password: !!str fake`), ending the line —
 * and never from a line that is a comment. The lines read are those deeper than the column the name (or the quote
 * before it) starts at, not the line's indent, so wrapped prose (`1. Set the password: fake⏎   then restart`) keeps
 * its next line; they end at a blank line, a comment line, a line no deeper than that column, an assignment of its
 * own (`NAME=value`) or a line that holds a mapping's `:` (`x: y`, `key:`).
 *
 * LINEAR: the value that ends the line is found once from its end, and each name on the line is looked at once.
 */
function continuedTo(
  written: readonly string[],
  index: number,
  isSecret: (name: string, value: string) => boolean,
): number {
  const line = (written[index] ?? '').trimEnd();
  if (COMMENT_LINE.test(line)) return index;
  let start = line.length;
  while (start > 0 && !VALUE_END.test(line.charAt(start - 1))) start -= 1;
  for (const found of line.matchAll(NAME_IN_LINE)) {
    const name = found[2] ?? '';
    if (!isSecret(name, BLOCK_PROBE)) continue;
    let at = found.index + found[0].length;
    PROPERTIES_AT.lastIndex = at;
    at += PROPERTIES_AT.exec(line)?.[0].length ?? 0;
    VALUE_LOOK.lastIndex = at;
    const value = at < start ? undefined : VALUE_LOOK.exec(line)?.[0];
    if (value === undefined || NO_VALUE_HEAD.test(value) || BLOCK_INDICATOR.test(value) || !isSecret(name, value)) {
      continue;
    }
    const column = found.index - (/["']/u.test(line.charAt(found.index - 1)) ? 1 : 0);
    let last = index;
    for (let next = index + 2; next < written.length; next += 2) {
      const below = written[next] ?? '';
      if (
        below.trim() === '' ||
        indentOf(below) <= column ||
        COMMENT_LINE.test(below) ||
        ASSIGNS.test(below) ||
        MAPS.test(below)
      ) {
        break;
      }
      last = next;
    }
    return last;
  }
  return index;
}

/** Whether the name at `at` is the inside of a pointer (`${secret:TOKEN}`), which is no name and value. */
const insidePointer = (text: string, at: number): boolean =>
  at >= 2 && text.startsWith('${', at - 2) && isPointer(text, at - 2);

/**
 * Where a cut of `text` from `start` to `end` must stop so that it takes no part of a private key: at the header of
 * one that starts inside it, or `end`. A cut that took the header would leave the key's body for no pass to find.
 */
function beforePrivateKey(text: string, start: number, end: number): number {
  const run = text.slice(start, end);
  for (let at = run.indexOf(PRIVATE_KEY_START); at >= 0; at = run.indexOf(PRIVATE_KEY_START, at + 1)) {
    PRIVATE_KEY_HEADER.lastIndex = start + at;
    if (PRIVATE_KEY_HEADER.test(text)) return start + at;
  }
  return end;
}

/** Where a private key stands among a text's lines: its first and last line (indices into the parts), and how far in. */
interface KeyPlace {
  readonly first: number;
  readonly from: number;
  readonly last: number;
  /** Where it ends on its last line (exclusive). */
  readonly to: number;
}

/** Every private key in the text split into `parts` (lines and the breaks between them), in order. */
function privateKeysIn(parts: readonly string[]): readonly KeyPlace[] {
  const text = parts.join('');
  if (!text.includes(PRIVATE_KEY_START)) return [];
  const places: KeyPlace[] = [];
  let part = 0;
  let offset = 0;
  /** The part that holds the character at `at`, and how far into it. */
  const locate = (at: number): readonly [number, number] => {
    while (offset + (parts[part] ?? '').length <= at) {
      offset += (parts[part] ?? '').length;
      part += 1;
    }
    return [part, at - offset];
  };
  for (const key of text.matchAll(PRIVATE_KEY)) {
    const [first, from] = locate(key.index);
    const [end, column] = locate(key.index + key[0].length - 1);
    // A key whose last character is a line break ends on the line before it.
    const last = end % 2 === 0 ? end : end - 1;
    places.push({ first, from, last, to: end % 2 === 0 ? column + 1 : (parts[last] ?? '').length });
  }
  return places;
}

/** `text` with what it holds, if anything, hidden between the spaces around it. */
const hiddenWithin = (text: string): string =>
  text.trim() === '' ? text : `${text.slice(0, indentOf(text))}${HIDDEN_TEXT}${text.slice(text.trimEnd().length)}`;

/**
 * The line of a block at `at`, hidden after its indent — but a private key that does not lie wholly inside the block
 * (the lines after its name's line `block[0]`, up to `block[1]`) is left as it is on it, and only the rest of the line
 * is hidden, so the key is cut whole by {@link CONTEXT_FREE_SECRET}: hiding its header or one line of its body here
 * would leave the rest of it showing. A key's place is read before any line is hidden, and still holds here: a value
 * reading changes only the line after its name (and its separator lines), where no block opens, so every block that
 * holds that line was read before it, and a line a block left a key on is never hidden whole after ({@link redactNextLines}).
 */
function hideBlockLine(line: string, at: number, block: readonly [number, number], keys: readonly KeyPlace[]): string {
  const left = keys.filter(key => key.first <= at && at <= key.last && (key.first <= block[0] || key.last > block[1]));
  if (left.length === 0) return `${line.slice(0, indentOf(line))}${HIDDEN_TEXT}`;
  let out = '';
  let from = 0;
  for (const key of left) {
    const start = Math.max(from, key.first === at ? key.from : 0);
    const end = Math.max(start, key.last === at ? key.to : line.length);
    out += hiddenWithin(line.slice(from, start)) + line.slice(start, end);
    from = end;
  }
  return out + hiddenWithin(line.slice(from));
}

/**
 * The value of a name that ends its line, on the lines after it (`password:⏎hunter2`, `password =⏎x`,
 * `PASSWORD⏎= x`, and a block `password: |⏎  x` or `PASSWORD⏎= |⏎  x`). A name is read as it was written (a value
 * after it on its line may be hidden by now), and a next line that is a key of its own is read on its own. One pass
 * over the lines: the block under a name that announces a secret is read as a whole, and a block opened deeper
 * inside it whose indicator stands inside it too is not read again (it ends inside it, and what the outer name hides
 * the inner one cannot show), and the block under any other name is not read at all. A block whose indicator stands
 * past the outer one (`password: |⏎  PASSWORD⏎= |`), or that is opened on a line that opens the outer one and stands
 * no deeper than its name (`password=⏎| # token: |`), can run past it, so it is read on its own. A hidden value that
 * ends its name's line is read on over the lines that continue it ({@link continuedTo}), each hidden after its indent
 * but for any private key on it, which is left to be cut whole; a line hidden whole already is left as it is. No
 * reading cuts into a private key ({@link beforePrivateKey}, {@link hideBlockLine}).
 */
function redactNextLines(
  original: string,
  text: string,
  isSecret: (name: string, value: string) => boolean,
): { readonly text: string; readonly redacted: boolean } {
  const parts = text.split(LINE_BREAKS);
  const asWritten = original.split(LINE_BREAKS);
  const keys = privateKeysIn(parts);
  /** The lines a block left a private key on: hidden around it already, and never hidden whole after. */
  const keptKeys = new Set<number>();
  let redacted = false;
  let covered = -1;
  let coveredBelow = -1;
  /** The last line of the value continued last ({@link continuedTo}). */
  let continued = -1;
  /** The value `reading` names on its line, hidden when it is a secret. */
  const readValue = ({ name, line: at, from: written, properties }: Reading): void => {
    const line = parts[at] ?? '';
    const skipped = properties === true ? PROPERTIES.exec(line.slice(written))?.[0].length : 0;
    if (skipped === undefined) return;
    const from = written + skipped;
    const rest = line.slice(from);
    const value = FIRST_VALUE.exec(rest);
    if (value?.[2] === HIDDEN_TEXT) return;
    const start = from + (value?.[1]?.length ?? 0);
    // A token already hidden at the head of the run (`ghp_x{y`) leaves the rest of its run showing: hide that too.
    const headHidden = value?.[2]?.startsWith(HIDDEN_TEXT) === true;
    if (
      value === null ||
      (properties === true && value[2]?.startsWith('#') === true) ||
      (!headHidden &&
        ((from === 0 && KEY_LINE.test(rest)) || isPointer(line, start) || !isSecret(name, value[2] ?? '')))
    ) {
      return;
    }
    const end = beforePrivateKey(line, start, from + value[0].length);
    if (end === start) return;
    parts[at] = `${line.slice(0, start)}${HIDDEN_TEXT}${line.slice(end)}`;
    redacted = true;
  };
  for (let index = 0; index < parts.length; index += 2) {
    const opens = opening(asWritten, index);
    const indent = indentOf(parts[index] ?? '');
    for (const block of opens.blocks) {
      if ((block.line <= covered && indent > coveredBelow) || !isSecret(block.name, BLOCK_PROBE)) continue;
      let last = index;
      for (let next = index + 2; next < parts.length; next += 2) {
        const line = parts[next] ?? '';
        if (line.trim() === '') continue;
        // The lines up to the one that holds the indicator (`PASSWORD⏎= |`, `password:⏎|`, `PASSWORD⏎=⏎|`) open
        // the block, so they never end it: each is read like any line of the block, as it always was when it stood
        // deeper than the name.
        if (next > block.line && indentOf(line) <= indent) break;
        last = next;
      }
      for (let next = index + 2; next <= last; next += 2) {
        const line = parts[next] ?? '';
        if (line.trim() === '' || keptKeys.has(next) || !isSecret(block.name, line.trim())) continue;
        parts[next] = hideBlockLine(line, next, [index, last], keys);
        if (parts[next] !== `${line.slice(0, indentOf(line))}${HIDDEN_TEXT}`) keptKeys.add(next);
        redacted = true;
      }
      covered = last;
      coveredBelow = indent;
    }
    // Only under a name that announces a secret, as a block is: what today hides by its shape alone it still does.
    for (const reading of opens.readings) if (isSecret(reading.name, BLOCK_PROBE)) readValue(reading);
    if (opens.value) readValue(opens.value);
    // A line a continued value was read over starts no value of its own: every one continued from it ends inside it.
    if (index <= continued) continue;
    continued = continuedTo(asWritten, index, isSecret);
    for (let next = index + 2; next <= continued; next += 2) {
      const line = parts[next] ?? '';
      const whole = `${line.slice(0, indentOf(line))}${HIDDEN_TEXT}`;
      // A line a block hid whole already may have held a key the block cut with it: there is nothing left to read.
      if (line === whole || keptKeys.has(next)) continue;
      // Every private key on the line is left whole (its first line is no later than this one), even one that lies
      // wholly inside the value: it is cut header to footer, line breaks and all, as today cuts it.
      parts[next] = hideBlockLine(line, next, [next, next], keys);
      if (parts[next] !== whole) keptKeys.add(next);
      redacted = true;
    }
  }
  return { text: parts.join(''), redacted };
}

/** The default of every `${NAME<op>default}` in `text` that is a secret when NAME holds it, hidden. */
function redactExpansions(
  text: string,
  isSecret: (name: string, value: string) => boolean,
): { readonly text: string; readonly redacted: boolean } {
  let out = '';
  let from = 0;
  let redacted = false;
  EXPANSION.lastIndex = 0;
  for (let found = EXPANSION.exec(text); found !== null; found = EXPANSION.exec(text)) {
    const start = found.index + found[0].length;
    const value = found[2] ?? '';
    if (start < from || value.startsWith(HIDDEN_TEXT) || !isSecret(found[1] ?? '', value)) continue;
    DEFAULT_RUN.lastIndex = start;
    const end = start + (DEFAULT_RUN.exec(text)?.[0].length ?? 0);
    out += `${text.slice(from, start)}${HIDDEN_TEXT}`;
    from = end;
    EXPANSION.lastIndex = end;
    redacted = true;
  }
  return { text: out + text.slice(from), redacted };
}

/**
 * The value after node properties that stand where a name's separator ends (`password: !!str fake`, `&pw fake`,
 * `!!binary fake`) and where it starts: {@link ASSIGNMENT} reads the properties as the value. None when no
 * properties stand there, or what follows them is a block indicator, a comment or a pointer.
 */
function valueAfterProperties(text: string, start: number): readonly [number, string] | undefined {
  PROPERTIES_AT.lastIndex = start;
  const found = PROPERTIES_AT.exec(text);
  if (found === null) return undefined;
  const at = start + found[0].length;
  VALUE_LOOK.lastIndex = at;
  const value = VALUE_LOOK.exec(text)?.[0];
  if (value === undefined || BLOCK_INDICATOR.test(value) || value.startsWith('#') || isPointer(text, at)) {
    return undefined;
  }
  return [at, value];
}

/** `text` with every cut hidden (in any order; cuts that overlap are hidden as one). */
function withCuts(text: string, cuts: readonly (readonly [number, number])[]): string {
  let out = '';
  let from = 0;
  let open: readonly [number, number] | undefined;
  for (const [start, end] of cuts.toSorted(([left], [right]) => left - right)) {
    if (open !== undefined && start < open[1]) {
      open = [open[0], Math.max(open[1], end)];
      continue;
    }
    if (open !== undefined) out += `${text.slice(from, open[0])}${HIDDEN_TEXT}`;
    from = open?.[1] ?? from;
    open = [start, end];
  }
  if (open !== undefined) out += `${text.slice(from, open[0])}${HIDDEN_TEXT}`;
  return out + text.slice(open?.[1] ?? from);
}

/**
 * A component's text with every secret-looking value replaced by {@link HIDDEN_TEXT}. `isSecret` is the rule for
 * a value beside its name (the fleet's `looksSecret` unless a caller needs a stricter one).
 */
function redactText(
  text: string,
  isSecret: (name: string, value: string) => boolean = looksSecret,
): { readonly text: string; readonly redacted: boolean } {
  const cuts: (readonly [number, number])[] = [];
  let from = 0;
  let afterFrom = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let found = ASSIGNMENT.exec(text); found !== null; found = ASSIGNMENT.exec(text)) {
    const start = found.index + found[0].length;
    const value = found[4] ?? '';
    const name = found[2] ?? '';
    // 5.0 (#36): the value after node properties, which today reads as the value (`password: !!str fake`), under a
    // name that announces a secret. Each cut is read once (`afterFrom`); today's cuts below are left as they were.
    const after = insidePointer(text, found.index) ? undefined : valueAfterProperties(text, start);
    if (after !== undefined && after[0] >= afterFrom && isSecret(name, BLOCK_PROBE) && isSecret(name, after[1])) {
      VALUE_RUN.lastIndex = after[0];
      const end = beforePrivateKey(text, after[0], after[0] + (VALUE_RUN.exec(text)?.[0].length ?? 0));
      if (end > after[0]) cuts.push([after[0], end]);
      afterFrom = end;
    }
    if (start < from || BLOCK_INDICATOR.test(value) || isPointer(text, start) || insidePointer(text, found.index)) {
      continue;
    }
    if (!isSecret(name, value)) continue;
    VALUE_RUN.lastIndex = start;
    const end = beforePrivateKey(text, start, start + (VALUE_RUN.exec(text)?.[0].length ?? 0));
    if (end === start) continue;
    cuts.push([start, end]);
    from = end;
    ASSIGNMENT.lastIndex = start;
  }
  let redacted = cuts.length > 0;
  const named = withCuts(text, cuts);
  const expanded = redactExpansions(named, isSecret);
  redacted = redacted || expanded.redacted;
  const bare = expanded.text.replace(WORD, word => {
    if (looksSecret('', word)) {
      redacted = true;
      return HIDDEN_TEXT;
    }
    const held = word.replace(LEADING_SEPARATORS, '');
    if (held === word || !looksSecret('', held)) return word;
    redacted = true;
    return `${word.slice(0, word.length - held.length)}${HIDDEN_TEXT}`;
  });
  const lines = redactNextLines(text, bare, isSecret);
  const cut = lines.text.replace(CONTEXT_FREE_SECRET, (match, offset: number, whole: string) => {
    if (!isContextFreeSecret(match, offset, whole)) return match;
    redacted = true;
    return HIDDEN_TEXT;
  });
  return { text: cut, redacted: redacted || lines.redacted };
}

/** What stands in place of a line of an instructions or hooks text that the write rule still refuses after the cut. */
export const WITHHELD_LINE = `${HIDDEN_TEXT}: this line is not shown because it looks like it holds a secret; it stays as written in the file`;

/**
 * The line net of a component's text: after {@link redactText}, each line (cut at `\n`, the unit the write rule reads)
 * that the write rule's text test (`rawTextHoldsSecret`) still refuses is replaced by {@link WITHHELD_LINE}, so no
 * line shown is one the write rule would refuse and every other line stays as the cut left it. A line is judged alone,
 * as the write rule judges it, and also by its parts when a lone `\r` splits it. Linear: each line is read once.
 */
function netTextLines(text: string, mode: TextMode): { readonly text: string; readonly withheld: boolean } {
  let withheld = false;
  // A hooks file is a JSON document the write rule judges by its parsed values: the lines its refused paths stand on.
  const document = mode === 'hooks' ? hooksDocumentRefusedLines(text) : undefined;
  // An instructions text is also a VALUE (held in the component YAML): the write rule's flag test reads a string with
  // blanks as words, and a flag may end one line while its value starts the next.
  const flagged = (line: string): boolean => mode === 'instructions' && findFlagSecrets({ text: line }).length > 0;
  let before = '';
  const lines = text.split('\n').map((unit, index) => {
    const carriage = unit.endsWith('\r') ? '\r' : '';
    const line = carriage === '' ? unit : unit.slice(0, -1);
    const last = lastWordOf(before);
    before = line;
    if (document === 'whole' || document?.has(index) === true) {
      withheld = true;
      return `${WITHHELD_LINE}${carriage}`;
    }
    // A lone `\r` is a line break to a reader, not to the write rule: the unit is refused whole, or by a part, and
    // each part it holds a secret in (all of them, when the whole is refused) is replaced, so the breaks stay.
    const whole = rawTextHoldsSecret(line) || flagged(line) || (last !== '' && flagged(`${last}\n${line}`));
    const parts = line.split('\r');
    if (!whole && (parts.length === 1 || !parts.some(part => rawTextHoldsSecret(part)))) return unit;
    withheld = true;
    return `${parts.map(part => (whole || rawTextHoldsSecret(part) ? WITHHELD_LINE : part)).join('\r')}${carriage}`;
  });
  return { text: lines.join('\n'), withheld };
}

/** What a text is read as: prose of an instructions file, a hooks JSON document, or any other text. */
type TextMode = 'instructions' | 'hooks' | 'plain';

/** The last blank-separated word of a line, `''` for a blank one (read from the end, once). */
function lastWordOf(line: string): string {
  let end = line.length;
  while (end > 0 && line.charAt(end - 1).trim() === '') end -= 1;
  let start = end;
  while (start > 0 && line.charAt(start - 1).trim() !== '') start -= 1;
  return line.slice(start, end);
}

/** A component's text as the views show it: cut by {@link redactText}, then netted line by line. */
function shownComponentText(text: string, mode: TextMode): { readonly text: string; readonly redacted: boolean } {
  const cut = redactText(text);
  const netted = netTextLines(cut.text, mode);
  return { text: netted.text, redacted: cut.redacted || netted.withheld };
}

const isTable = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;

/**
 * A settings document as dotted keys, sorted: an object nests, and an array, a scalar or `{}` is one
 * entry. The inverse of what an edit by entry builds.
 */
function flattenSettings(settings: SettingsObject): readonly (readonly [string, unknown])[] {
  const entries: (readonly [string, unknown])[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (prefix !== '' && !isTable(value)) {
      entries.push([prefix, value]);
      return;
    }
    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      walk(prefix === '' ? key : `${prefix}.${key}`, child);
    }
  };
  walk('', settings);
  return entries.toSorted(([left], [right]) => byName(left, right));
}

/** A settings value in words: a string as it is, anything else as its JSON text. */
const settingsValueText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

function settingsEntries(settings: SettingsObject): SettingsEntry[] {
  return flattenSettings(settings).map(([key, value]) => {
    const text = settingsValueText(value);
    return looksSecret(key, text) || valueWithheld(key, value) ? { key, hidden: true as const } : { key, value: text };
  });
}

function componentContent(kind: ComponentKind, name: string, facts: CatalogFacts): ComponentContent | undefined {
  if (kind === 'settings') {
    const body = facts.settingsBodies?.[name];
    return body === undefined ? undefined : { form: 'entries', entries: settingsEntries(body) };
  }
  const text =
    kind === 'instructions' ? facts.instructionBodies?.[name] : kind === 'hooks' ? facts.hooksTexts?.[name] : undefined;
  if (text === undefined) return undefined;
  return { form: 'text', ...shownComponentText(text, kind === 'hooks' ? 'hooks' : 'instructions') };
}

/** A path under a person's home on macOS or Linux, as it appears in text (U15's clone uses the same). */
const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/gu;

/**
 * E30: the first path this component names under somebody else's home — a component copied from
 * another machine still pointing there. A path under this machine's own home is not one.
 */
function checkPathOf(kind: ComponentKind, name: string, component: Record<string, unknown>, facts: CatalogFacts) {
  const texts: string[] = [];
  // The same text the detail shows: an instructions or a hooks file is netted as its kind, any other text as plain.
  const mode: TextMode = kind === 'instructions' || kind === 'hooks' ? kind : 'plain';
  if (kind === 'instructions') texts.push(facts.instructionBodies?.[name] ?? '');
  if (kind === 'hooks') texts.push(facts.hooksTexts?.[name] ?? '');
  if (kind === 'settings') {
    // A hidden value is never searched: its path would say what it was.
    const entries = settingsEntries(facts.settingsBodies?.[name] ?? {});
    texts.push(...entries.flatMap(entry => ('value' in entry ? [entry.value] : [])));
  }
  if (kind === 'mcp') {
    for (const field of ['command', 'url'] as const) {
      if (typeof component[field] === 'string') texts.push(component[field] as string);
    }
    if (Array.isArray(component.args)) texts.push(...(component.args as string[]));
  }
  const home = facts.userHome;
  for (const text of texts) {
    for (const match of shownComponentText(text, mode).text.matchAll(HOME_PATH)) {
      const path = match[0];
      if (path !== home && !path.startsWith(`${home}/`)) return path;
    }
  }
  return undefined;
}

/** `GET /v1/fleet/components`. */
export function componentCatalog(model: AccountModel, facts: CatalogFacts): ComponentCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    kinds: KIND_GROUPS.map(group => ({
      ...group,
      components: Object.entries(model.components[group.kind] as Record<string, Record<string, unknown>>)
        .toSorted(([left], [right]) => byName(left, right))
        .map(([name, component]) => {
          const reference = `${group.kind}/${name}` as LayerReferenceText;
          const usage = componentUsage(model, reference);
          const harness = typeof component.harness === 'string' ? (component.harness as HarnessKind) : undefined;
          const command = typeof component.command === 'string' ? component.command : undefined;
          const missing = command !== undefined && facts.missingCommands?.has(command) === true;
          const content = componentContent(group.kind, name, facts);
          const checkPath = checkPathOf(group.kind, name, component, facts);
          return {
            reference,
            kind: group.kind,
            name,
            ...(harness === undefined ? {} : { harness: harnessKey(harness) }),
            scope: scopeKey(componentScope(group.kind, component)),
            detail: componentDetail(group.kind, component),
            partial: partial
              .filter(entry => entry.reference === reference)
              .map(entry => ({ harness: harnessKey(entry.harness), reason: describePartialSupport(entry) })),
            // The warning names the command, so it goes through the same net as the detail's `command`.
            warnings: missing
              ? [
                  command !== undefined && commandWithheld(command)
                    ? 'Command not found'
                    : `Command not found: ${command as string}`,
                ]
              : [],
            usedBy: { profiles: usage.profiles, runtimes: usage.runtimes },
            editNote: editConsequence(usage) ?? 'Nothing uses it yet.',
            remove: act(
              usage.direct.length === 0
                ? undefined
                : `It is a layer in ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
            ),
            ...(content === undefined ? {} : { content }),
            ...(checkPath === undefined ? {} : { checkPath }),
            ...(typeof component.clonedFrom === 'string' ? { clonedFrom: component.clonedFrom } : {}),
            ...(typeof component.clonedFromDaemon === 'string' ? { clonedFromDaemon: component.clonedFromDaemon } : {}),
            ...(component.installedFrom === undefined
              ? {}
              : { installedFrom: component.installedFrom as ComponentView['installedFrom'] }),
          };
        }),
    })),
  };
}

/** A layer's own name, the way a profile shows it. */
const layerName = (layer: FlatLayer): string => layer.name;

/** A component's words in a skip note: "Settings claude-settings". */
const KIND_LABELS: Readonly<Record<ComponentKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

function skippedSentence(skip: SkippedLayer, harness: HarnessKind): string {
  const what = `${KIND_LABELS[skip.layer.componentKind]} ${skip.layer.name}`;
  if (skip.reason === 'no-model-for-harness') {
    return `${what} has no ${HARNESS_DISPLAY_NAMES[harness]} model, so it is skipped on ${HARNESS_DISPLAY_NAMES[harness]}.`;
  }
  return `${what} is for ${HARNESS_DISPLAY_NAMES[skip.harness ?? harness]} only, so it is skipped on ${HARNESS_DISPLAY_NAMES[harness]}.`;
}

/** P5, E14: why a profile cannot be used with a login of this harness. */
function unavailableReason(resolved: ResolvedProfile): string | undefined {
  const availability = resolved.availability;
  if (availability.available) return undefined;
  if (availability.reason === 'empty') return 'This profile has no layers yet.';
  const owners = new Set(resolved.skipped.flatMap(skip => (skip.harness === undefined ? [] : [skip.harness])));
  const only = owners.size === 1 ? HARNESS_DISPLAY_NAMES[[...owners][0] as HarnessKind] : undefined;
  return only === undefined
    ? `Nothing here applies on ${HARNESS_DISPLAY_NAMES[resolved.harness]}.`
    : `Only ${only} settings. Nothing here applies on ${HARNESS_DISPLAY_NAMES[resolved.harness]}.`;
}

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

function conflictView(conflict: Conflict): LayerConflict {
  return {
    harness: harnessKey(conflict.harness),
    field: conflict.field,
    key: conflict.key,
    // A value the write rule refuses is not in the sentence (`valueSaid`), judged under the name the document holds it by.
    sentence: describeConflict(conflict, (found, value) =>
      valueSaid(found.path.findLast(part => typeof part === 'string') ?? found.key, value),
    ),
    winner: layerName(conflict.winner.layer),
    overridden: conflict.overridden.map(setter => layerName(setter.layer)),
  };
}

/** A profile resolved for one harness, or `undefined` when it cannot be (a document the schema refused). */
function resolvedFor(
  model: AccountModel,
  profile: string,
  harness: HarnessKind,
  facts: CatalogFacts,
  partial: readonly PartialSupport[],
): ResolvedProfile | undefined {
  const result = resolveProfile({
    model,
    profile,
    harness,
    partialSupport: partial,
    ...(facts.settingsBodies === undefined ? {} : { settingsBodies: facts.settingsBodies }),
  });
  return result.ok ? result.resolved : undefined;
}

function stackView(resolved: ResolvedProfile | undefined, harness: HarnessKind): StackView {
  if (resolved === undefined) {
    return {
      harness: harnessKey(harness),
      available: { available: false, reason: 'This profile cannot be read.' },
      applied: [],
      skipped: [],
      conflicts: [],
      partial: [],
    };
  }
  return {
    harness: harnessKey(harness),
    available: act(unavailableReason(resolved)),
    applied: resolved.applied.map(layer => layer.reference),
    skipped: resolved.skipped.map(skip => ({
      reference: skip.layer.reference,
      sentence: skippedSentence(skip, harness),
    })),
    conflicts: resolved.conflicts.map(conflictView),
    partial: resolved.partial.map(entry => ({ reference: entry.reference, reason: describePartialSupport(entry) })),
  };
}

/** A profile's derived scope as the wire carries it: a mixed one as the sentence naming its layers. */
const scopeView = (scope: ProfileScope, name: string | undefined): ProfileScopeView =>
  scope.kind === 'mixed'
    ? { kind: 'mixed', sentence: describeScopeConflict(scope, name) }
    : { kind: 'scoped', scope: scopeKey(scope.scope) };

/** `GET /v1/fleet/profiles`. */
export function profileCatalog(model: AccountModel, facts: CatalogFacts): LayeredProfileCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    profiles: Object.entries(model.profiles)
      .toSorted(([left], [right]) => byName(left, right))
      .map(([name, profile]) => {
        const usage = profileUsage(model, name);
        return {
          name,
          layers: [...profile.layers],
          usedBy: runtimesUsingProfile(model, name),
          baseFor: usage.direct,
          wouldIncludeItself: Object.keys(model.profiles)
            .filter(other => wouldIncludeItself(model.profiles, name, other))
            .toSorted(byName),
          scope: scopeView(profileScope(model, name), name),
          harnesses: HARNESSES.map(harness => stackView(resolvedFor(model, name, harness, facts, partial), harness)),
          remove: act(
            usage.direct.length === 0
              ? undefined
              : `It is a base for ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
          ),
        };
      }),
  };
}

function modelSetView(resolved: ResolvedProfile | undefined): RuntimeModelSet {
  const set = resolved?.modelSet;
  if (set === undefined || set.source === 'harness-default') return { source: 'harness-default' };
  return {
    source: 'model-set',
    name: set.layer.name,
    models: set.models.map(model => ({ id: model.id, available: model.available })),
    declaredDefault: set.declaredDefault,
    ...(set.default === undefined ? {} : { default: set.default }),
  };
}

/** What a runtime offers from its login's model catalog (docs/model-catalog.md), when it reads one. */
function modelsView(
  resolved: ResolvedProfile | undefined,
  harness: HarnessKind,
  credential: AccountModel['credentials'][string],
  sources: ModelCatalogSources | undefined,
): { readonly models?: RuntimeModels } {
  if (sources === undefined) return {};
  const derived = runtimeModels({
    harness,
    modelSet: resolved?.modelSet,
    ...loginModelCatalog(credential, harness, sources),
  });
  if (derived.catalog === undefined) return {};
  return {
    models: {
      catalog: derived.catalog,
      choices: derived.models.map(model => ({
        ...model,
        efforts: [...model.efforts],
        // Claude's fast mode is a rule on the model id; Codex's is the live account's to say.
        ...(harness === 'claude' ? { fast: claudeFastSupport(model.id) } : {}),
      })),
      ...(derived.default === undefined ? {} : { default: derived.default }),
      ...(derived.local === undefined ? {} : { local: derived.local }),
    },
  };
}

/** A fixed-layer entry in words: trust and onboarding by what they switch off. */
const FIXED_ENTRY_WORDS: Readonly<Partial<Record<FixedEntry['purpose'], { key: string; value: string }>>> = {
  trust: { key: 'trust prompt', value: 'off' },
  onboarding: { key: 'onboarding screens', value: 'off' },
  'remote-control': { key: 'Remote Control at startup', value: 'off' },
  'one-time-prompts': { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
  tools: { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
  instructions: { key: 'Ferretry tools instruction', value: 'on' },
};

/** The folder the read-only view is computed for: entries naming a folder are shown by purpose. */
const VIEW_FOLDER = '/ferretry-launch-folder';

/** The `fy` the read-only view shows the tools server running as; the wrapper names the real path. */
const VIEW_FY_COMMAND = 'fy';

const OVERRIDE_SENTENCE = (from: string): string => `From your ${from} · Overridden for agents by Ferretry`;

/**
 * A profile flag the fixed layer dropped, as `GET /v1/runtimes` names it: its words through the one command-line
 * rule (`./command-line.ts`), so `--append-system-prompt=sk-…` or `--append-system-prompt`, `sk-…` loses its value in
 * the key and the value both, for every caller.
 */
function overriddenFlag(tokens: readonly string[]): { readonly key: string; readonly value: string } {
  const line = shownLine(tokens);
  // THE NET: a flag the write rule still refuses once the cutter has had its say is not shown, key and value both.
  if (line.withheld) return { key: WITHHELD_WORDS_TEXT, value: WITHHELD_WORDS_TEXT };
  const shown = line.words.map(word => word.text);
  return { key: shown[0] as string, value: shown.join(' ') };
}

function fixedLayerView(
  model: AccountModel,
  harness: HarnessKind,
  resolved: ResolvedProfile | undefined,
  facts: CatalogFacts,
): { readonly view?: FixedLayerView; readonly refusal?: string } {
  const result =
    harness === 'claude'
      ? fixedLayerFor({
          harness,
          agentPermissions: model.machine.agentPermissions,
          cwd: VIEW_FOLDER,
          acceptsAutoPermissionMode: facts.acceptsAutoPermissionMode,
          fyCommand: VIEW_FY_COMMAND,
        })
      : fixedLayerFor({
          harness,
          agentPermissions: model.machine.agentPermissions,
          cwd: VIEW_FOLDER,
          fyCommand: VIEW_FY_COMMAND,
        });
  if (!result.ok) return { refusal: result.refusal.message };
  const fixed = result.layer;
  const overridden =
    resolved === undefined
      ? []
      : applyFixedLayer(resolved, fixed).overridden.map(entry =>
          entry.kind === 'setting'
            ? {
                key: entry.key,
                value: valueSaid(entry.key, entry.value),
                from: entry.layer.name,
                sentence: OVERRIDE_SENTENCE(entry.layer.name),
              }
            : {
                ...overriddenFlag(entry.tokens),
                from: entry.layer.name,
                sentence: OVERRIDE_SENTENCE(entry.layer.name),
              },
        );
  return {
    view: {
      agentPermissions: fixed.agentPermissions,
      // One row per thing switched off: several keys share a purpose, and the person reads the purpose.
      entries: fixed.entries
        .map(entry => FIXED_ENTRY_WORDS[entry.purpose] ?? { key: entry.key, value: shown(entry.value) })
        .filter((row, index, rows) => rows.findIndex(other => other.key === row.key) === index),
      overridden,
    },
  };
}

/** `GET /v1/fleet/runtimes`. */
export function runtimeCatalog(model: AccountModel, facts: CatalogFacts): RuntimeCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    runtimes: Object.entries(model.runtimes)
      .toSorted(([left], [right]) => byName(left, right))
      .flatMap(([name, runtime]) => {
        const credential = model.credentials[runtime.credential];
        // Present by construction: the schema refused a runtime on an unknown login.
        if (credential === undefined) return [];
        // A login that drives both CLIs runs the one this runtime is for.
        const harness = runtimeHarness(model, runtime) as HarnessKind;
        const resolved = resolvedFor(model, runtime.profile, harness, facts, partial);
        const stack = stackView(resolved, harness);
        const fixed = runtime.agent ? fixedLayerView(model, harness, resolved, facts) : {};
        const status = facts.credentialStatus?.[runtime.credential];
        const off = runtimeDisable(model, name, facts.now ?? 0, VIEW_FY_COMMAND, facts.budgetHolds);
        const blocked =
          off !== undefined
            ? off.clauses.join('. ')
            : facts.tools[harness] === undefined
              ? `Install ${HARNESS_DISPLAY_NAMES[harness]} to launch`
              : status === 'needs_sign_in'
                ? 'Sign in to launch'
                : stack.available.available
                  ? fixed.refusal
                  : stack.available.reason;
        // A runtime whose apply never landed has no id yet; its name stands in, and it cannot have
        // a session for any other id to name.
        const id = facts.runtimeIds?.[name] ?? name;
        const skipped = facts.skipped?.[id] ?? [];
        return [
          {
            id,
            name,
            // The wrapper is named after the runtime (`<bin>/<name>`), and `fy start --agent` takes that name.
            wrapper: name,
            harness: harnessKey(harness),
            credential: {
              id: runtime.credential,
              store: credential.store,
              ...(credential.label === undefined ? {} : { label: credential.label }),
              ...(status === undefined ? {} : { status }),
            },
            profile: runtime.profile,
            agent: runtime.agent,
            stack,
            modelSet: modelSetView(resolved),
            ...modelsView(resolved, harness, credential, facts.modelCatalogs),
            ...(fixed.view === undefined ? {} : { fixedLayer: fixed.view }),
            launch: act(blocked),
            // A budget alone is no switch: the runtime cannot launch (its `launch` says why), but nothing is off.
            ...(off === undefined || (off.own === undefined && off.login === undefined)
              ? {}
              : { disabled: runtimeDisabledView(off) }),
            sameAs: Object.entries(model.runtimes)
              .filter(
                ([other, peer]) =>
                  other !== name && peer.credential === runtime.credential && peer.profile === runtime.profile,
              )
              .map(([other]) => other)
              .toSorted(byName),
            ...(skipped.length === 0 ? {} : { skipped }),
          },
        ];
      }),
  };
}

// ── Layers ───────────────────────────────────────────────────────────────────────────────────────

/** The product's word for each kind, singular, as a sentence uses it. The fleet's, so a scope refusal and a layer refusal say a layer the same way. */
export const KIND_WORDS = COMPONENT_KIND_WORDS;

/** The plain words for a layer in a refusal: "profile base", "instructions main". */
/**
 * Why profile `name` cannot have these layers — one that is not a layer, is there twice, does not
 * exist, would include the profile itself (P3, E19), or would make it both Claude only and Codex only
 * (P7) — or `undefined` when it can. The one reading a save refuses with and a draft preview reports.
 * `named` is false for a draft that has no name yet, so its sentence says "A profile".
 */
export function layersRefusal(
  model: AccountModel,
  name: string,
  layers: readonly string[],
  named = true,
): string | undefined {
  const seen = new Set<string>();
  for (const text of layers) {
    const reference = parseLayerReference(text);
    if (reference === undefined) return `"${text}" is not a layer — write <kind>/<name> or profile/<name>`;
    if (seen.has(text)) return `${layerWords(text)} is in the layers twice`;
    seen.add(text);
    if (reference.kind === 'profile') {
      if (model.profiles[reference.name] === undefined) return `no profile ${reference.name} exists on this machine`;
      if (wouldIncludeItself(model.profiles, name, reference.name)) {
        return `profile ${reference.name} would include itself: it is ${name} or is built on it`;
      }
      continue;
    }
    if (model.components[reference.componentKind][reference.name] === undefined) {
      return `no ${KIND_WORDS[reference.componentKind]} ${reference.name} exists on this machine`;
    }
  }
  const scope = layersScope(model, layers, name);
  return scope.kind === 'mixed' ? describeScopeConflict(scope, named ? name : undefined) : undefined;
}

/** The name a draft that is not an edit stands under: one no profile has. */
const DRAFT_NAME = 'draft';

/**
 * `POST /v1/fleet/profiles/preview`: a profile's layers before they are saved, resolved per
 * harness exactly as {@link profileCatalog} resolves a saved one. The draft stands in a copy of the
 * model under the profile being edited, or a name no profile has.
 */
export function profileDraftView(
  model: AccountModel,
  request: ProfileDraftRequest,
  facts: CatalogFacts,
): ProfileDraftView {
  const name = request.editing ?? freeName(DRAFT_NAME, candidate => model.profiles[candidate] !== undefined);
  const draft = {
    ...model,
    profiles: { ...model.profiles, [name]: { layers: [...request.layers] as LayerReferenceText[] } },
  } as AccountModel;
  const partial = partialSupportOf(draft, facts);
  const refusal = layersRefusal(model, name, request.layers, request.editing !== undefined);
  const stacks = HARNESSES.map(harness => ({ harness, resolved: resolvedFor(draft, name, harness, facts, partial) }));
  return {
    harnesses: stacks.map(stack => stackView(stack.resolved, stack.harness)),
    resolved: stacks.flatMap(stack => (stack.resolved === undefined ? [] : resolvedEntries(stack.resolved))),
    scope: scopeView(layersScope(model, request.layers, name), request.editing),
    ...(refusal === undefined ? {} : { refusal }),
  };
}
