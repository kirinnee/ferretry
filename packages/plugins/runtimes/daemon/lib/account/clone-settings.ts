/**
 * Settings, merged key by key on a repeat copy (docs/design/account-model.md §3.8, §5).
 *
 * A copy used to take `warden.yaml`, `learning.yaml` and `voice.yaml` whole and the machine's controls as one
 * change, so a repeat copy overwrote a local edit to any of them. Here each document is a set of KEYS, and the
 * same three-way comparison the items use (design §3) decides each one:
 *
 * - **Keys** are dotted paths down to scalars; a list is ONE value (a reordered or edited list is one change).
 * - **The base** is the record's per-key digest of what the source held at the last copy. Three-way outcomes:
 *   `theirs` (changed on the source), `mine` (changed here, kept), `both` (asked, nothing pre-selected), `new`,
 *   `gone`, `removed-here`. A key both sides agree on is not listed.
 * - **The merged text is built from THIS machine's file** with only the taken keys changed, through
 *   {@link editConfigText}, so its comments and key order survive. A key nobody took is never touched.
 * - **Controls** (`agentPermissions`, `agentControl.*`, `defaultRuntime`) are one keyed document too; taking
 *   some of them is a smaller `machine.settings` change with only those fields.
 *
 * Pure: texts and digests in, a review and a plan out. Writing the files — validated, and HELD when a write
 * loosens — is the daemon's, through the same door as `PUT /v1/config/file`. **Nothing here reads, writes or
 * names a credential, a secret-store entry or the target of a `${secret:NAME}` reference.**
 */
import {
  CLONE_SETTINGS_KEYS_LIMIT,
  type CloneKeyChoice,
  type CloneOutcome,
  type CloneReviewSettings,
  type CloneSettingsDecisions,
  type CloneSettingsDoc,
} from '../../../contract/index.ts';
import { sha256Hex } from '../foreign.ts';
import { z } from 'zod';
import type { ConfigText } from '../ports.ts';
import { CloneRefusal } from './clone-parts.ts';
import { AgentPermissionsSchema, type Machine, RuntimeNameSchema } from './schema.ts';

// ── Documents ────────────────────────────────────────────────────────────────────────────────────

/** The settings documents that are configuration files, by the singleton each is. */
const FILE_KINDS = { 'warden.yaml': 'warden', 'learning.yaml': 'learning', 'voice.yaml': 'voice' } as const;
type FileDoc = keyof typeof FILE_KINDS;

const isFileDoc = (path: CloneSettingsDoc): path is FileDoc => path in FILE_KINDS;

/** The controls the source reports: every field optional, because a source may predate one. */
const ControlsSchema = z.strictObject({
  agentPermissions: AgentPermissionsSchema.optional(),
  defaultRuntime: RuntimeNameSchema.nullable().optional(),
  agentControl: z
    .strictObject({
      terminals: z.boolean().optional(),
      browsers: z.boolean().optional(),
      files: z.boolean().optional(),
      ferretrySettings: z.boolean().optional(),
      pageScripts: z.boolean().optional(),
    })
    .optional(),
});
export type CloneControls = z.infer<typeof ControlsSchema>;

/** This machine's controls as the document a copy compares: every field, so nothing reads as "unset". */
export function controlsDocument(
  machine: Pick<Machine, 'agentPermissions' | 'defaultRuntime' | 'agentControl'>,
): string {
  return JSON.stringify({
    agentPermissions: machine.agentPermissions,
    ...(machine.defaultRuntime === undefined ? {} : { defaultRuntime: machine.defaultRuntime }),
    agentControl: {
      terminals: machine.agentControl.terminals,
      browsers: machine.agentControl.browsers,
      files: machine.agentControl.files,
      ferretrySettings: machine.agentControl.ferretrySettings,
      pageScripts: machine.agentControl.pageScripts,
    },
  });
}

/** The machine with ONLY the controls taken changed: `defaultRuntime: null` unsets it. Nothing else is touched. */
export function applyControls(machine: Machine, taken: CloneControls): Machine {
  const { defaultRuntime: _current, ...rest } = machine;
  const defaultRuntime =
    taken.defaultRuntime === undefined ? machine.defaultRuntime : (taken.defaultRuntime ?? undefined);
  return {
    ...rest,
    ...(taken.agentPermissions === undefined ? {} : { agentPermissions: taken.agentPermissions }),
    ...(defaultRuntime === undefined ? {} : { defaultRuntime }),
    agentControl: {
      ...machine.agentControl,
      ...Object.fromEntries(Object.entries(taken.agentControl ?? {}).filter(([, value]) => value !== undefined)),
    },
  };
}

// ── Keys and values ──────────────────────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A key segment that can be written as a dotted path without ambiguity. An object with any other kind of key
 * (a dot in it, a name that would reach the prototype) is ONE value: coarser, never wrong.
 */
const SEGMENT = /^[A-Za-z0-9_-]+$/u;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isSegment = (key: string): boolean => SEGMENT.test(key) && !RESERVED.has(key);

/** Dotted path → value, for every scalar, list and empty mapping in a document. */
function flatten(value: unknown, prefix: readonly string[], into: Map<string, unknown>): void {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every(isSegment)) {
      for (const key of keys) flatten(value[key], [...prefix, key], into);
      return;
    }
  }
  if (prefix.length > 0) into.set(prefix.join('.'), value);
}

const under = (key: string, prefix: string): boolean => key.startsWith(`${prefix}.`);

/** The value a document holds at a dotted path (a path `flatten` produced, so every step is a plain mapping). */
function valueAt(root: Readonly<Record<string, unknown>>, path: string): unknown {
  let at: unknown = root;
  for (const segment of path.split('.')) at = (at as Record<string, unknown>)[segment];
  return at;
}

/**
 * The paths where one side holds a value (a scalar, a list, an empty mapping) and the other a mapping with keys
 * beneath it. A decision about the one is a decision about everything under the other, so the pair is compared at
 * that path as ONE value (the whole subtree each side holds there), never leaf by leaf. (No two of them nest: a
 * side that holds a value at one path holds nothing beneath it.)
 */
function structuralPaths(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): string[] {
  const found = new Set<string>();
  for (const [from, to] of [
    [left, right],
    [right, left],
  ] as const) {
    for (const key of from.keys()) {
      const segments = key.split('.');
      for (let length = 1; length < segments.length; length += 1) {
        const ancestor = segments.slice(0, length).join('.');
        if (to.has(ancestor)) found.add(ancestor);
      }
    }
  }
  return [...found];
}

/** The values with each key at or under a structural path folded into that path's whole subtree. */
function collapse(
  values: ReadonlyMap<string, unknown>,
  root: Readonly<Record<string, unknown>>,
  paths: readonly string[],
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of values) {
    const path = paths.find(candidate => key === candidate || under(key, candidate));
    if (path === undefined) out.set(key, value);
    else if (!out.has(path)) out.set(path, valueAt(root, path));
  }
  return out;
}

/** JSON with every object's keys in order, so two spellings of one value digest alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const digestOf = (value: unknown): string => sha256Hex(canonical(value));

/** A value as the screen shows it: configuration text, kept to a line or two. A `${secret:NAME}` stays a reference. */
function display(value: unknown): string {
  const text = typeof value === 'string' ? value : canonical(value);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

type Reading = { values: Map<string, unknown>; root: Record<string, unknown> };

/** A document's keys, flattened, and the document itself. */
function reading(root: unknown): Reading {
  const values = new Map<string, unknown>();
  flatten(root, [], values);
  return { values, root: root as Record<string, unknown> };
}

/** What the machine controls say, key by key; the sentence they are refused with when they cannot be read. */
function readControls(text: string, whose: string): Reading {
  try {
    const parsed = ControlsSchema.safeParse(text.trim() === '' ? {} : JSON.parse(text));
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'not the machine controls');
    // A field the source did not report is absent, and an unset default runtime is absent too.
    const { defaultRuntime, ...rest } = parsed.data;
    return reading({ ...rest, ...(defaultRuntime === null || defaultRuntime === undefined ? {} : { defaultRuntime }) });
  } catch (error) {
    throw new CloneRefusal(
      `${whose} controls could not be read: ${error instanceof Error ? error.message : 'not JSON'}.`,
    );
  }
}

/** What a settings file says, key by key; the sentence it is refused with when it cannot be read. */
function readFile(config: ConfigText, path: FileDoc, text: string, whose: string): Reading {
  const parsed = config.read(text);
  if (!parsed.ok) {
    throw new CloneRefusal(`${whose} ${path} could not be read: ${parsed.errors[0]?.message ?? 'not valid YAML'}.`);
  }
  const root = parsed.read.value;
  if (!isPlainObject(root)) throw new CloneRefusal(`${whose} ${path} is not a mapping of settings.`);
  return reading(root);
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────────

/** One settings document, both sides, and what the record remembers of the source's. */
export interface CloneSettingsInput {
  readonly path: CloneSettingsDoc;
  /** The source's document: the file's text (the empty text for a file the source has none of), or the controls as JSON. */
  readonly theirs: string;
  /** This machine's document now: the file's text on disk, or the controls as JSON. */
  readonly mine: string;
  /** Whether this machine has the file at all (the controls always exist). */
  readonly mineExists: boolean;
  /** The singleton as it is IN EFFECT here, for judging what taking a key would loosen. Absent: not judged. */
  readonly effective?: unknown;
}

interface Row {
  readonly key: string;
  readonly outcome: CloneOutcome;
  readonly choice?: CloneKeyChoice;
  readonly mine?: unknown;
  readonly theirs?: unknown;
  readonly loosens?: boolean;
}

interface FileAnalysis {
  readonly input: CloneSettingsInput;
  readonly rows: readonly Row[];
  /** Why this document cannot be copied here; none of its keys can be applied until it is left out. */
  readonly refused?: string;
  /** The text held a secret, so no digest of it may leave the analysis (not even in the fingerprint). */
  readonly withheld?: true;
  /** The digest of every key the source's document holds: the base after this copy. */
  readonly theirsDigests: Readonly<Record<string, string>>;
  /** This machine's document as parsed, kept to build the merge from. */
  readonly root: Record<string, unknown>;
  /** The config layer a settings FILE was reviewed through; the plan writes through the same one. The controls have none. */
  readonly config?: ConfigText;
}

export interface CloneSettingsAnalysis {
  readonly files: readonly FileAnalysis[];
  /** Binds the review to the texts it was made from and the record it was compared with. */
  readonly fingerprint: string;
}

const DEFAULT_CHOICE: Readonly<Partial<Record<CloneOutcome, CloneKeyChoice>>> = {
  new: 'take',
  theirs: 'take',
  mine: 'keep',
  gone: 'keep',
  'removed-here': 'keep',
};

/** What each outcome allows. `mine` can only be kept: the source did not change it. */
const KEY_CHOICES: Readonly<Record<CloneOutcome, readonly CloneKeyChoice[]>> = {
  new: ['take', 'keep'],
  theirs: ['take', 'keep'],
  mine: ['keep'],
  both: ['take', 'keep'],
  gone: ['keep', 'take'],
  'removed-here': ['keep', 'take'],
};

/**
 * How one key stands (design §3, per key). `base` is the record's digest for it, `undefined` when it has none;
 * `known` is whether the record holds this document at all.
 */
function outcomeOf(
  mine: string | undefined,
  theirs: string | undefined,
  base: string | undefined,
  known: boolean,
): CloneOutcome | undefined {
  if (mine === theirs) return undefined;
  if (mine === undefined) {
    // The source has it and this machine does not: new here, or removed here since the last copy.
    if (!known || base === undefined) return 'new';
    return theirs === base ? 'removed-here' : 'both';
  }
  if (theirs === undefined) {
    // Only this machine has it: a local addition says nothing about the source; one the source dropped is `gone`.
    if (!known || base === undefined) return undefined;
    return mine === base ? 'gone' : 'both';
  }
  if (!known || base === undefined) return 'both';
  if (mine === base) return 'theirs';
  if (theirs === base) return 'mine';
  return 'both';
}

/** The sentences a text's value would loosen against what is in effect, or `undefined` when it cannot be judged. */
function looseningOf(
  config: ConfigText,
  path: FileDoc,
  effective: unknown,
  text: string,
): ReadonlySet<string> | undefined {
  const sentences = config.loosening(path, effective, text);
  return sentences === undefined ? undefined : new Set(sentences);
}

/** What taking this controls key would loosen, in the words `machine.yaml`'s rules use. */
function controlsLoosen(key: string, mine: unknown, theirs: unknown): boolean {
  if (key === 'agentPermissions') return mine === 'auto' && theirs === 'skip';
  if (key.startsWith('agentControl.')) return mine !== true && theirs === true;
  return false;
}

/** The merged value of a document: this machine's, with each taken key set to the source's value or removed. */
function merge(
  root: Readonly<Record<string, unknown>>,
  taken: ReadonlyMap<string, { readonly value: unknown; readonly present: boolean }>,
): Record<string, unknown> {
  const merged = structuredClone(root);
  // Removals first, so a parent that becomes a plain value can take a new key beneath it.
  const ordered = [...taken].toSorted(([left, a], [right, b]) =>
    a.present === b.present ? left.localeCompare(right) : a.present ? 1 : -1,
  );
  for (const [key, entry] of ordered) {
    const path = key.split('.');
    if (!entry.present) {
      // The mappings down to the key. A path that is not there (a parent already pruned, or a plain value in its
      // place) leaves `at` undefined to the end, and there is then nothing to remove.
      const trail: unknown[] = [];
      let at: unknown = merged;
      for (const segment of path.slice(0, -1)) {
        trail.push(at);
        at = isPlainObject(at) && Object.hasOwn(at, segment) ? at[segment] : undefined;
      }
      if (!isPlainObject(at)) continue;
      Reflect.deleteProperty(at, path.at(-1) as string);
      // A mapping this left empty is removed with its last key, up to the document itself.
      for (let depth = path.length - 2; depth >= 0; depth -= 1) {
        const parent = trail[depth] as Record<string, unknown>;
        const child = parent[path[depth] as string];
        if (isPlainObject(child) && Object.keys(child).length === 0)
          Reflect.deleteProperty(parent, path[depth] as string);
        else break;
      }
      continue;
    }
    let at = merged;
    for (const segment of path.slice(0, -1)) {
      const next = Object.hasOwn(at, segment) ? at[segment] : undefined;
      if (isPlainObject(next)) at = next;
      else {
        const created: Record<string, unknown> = {};
        Object.defineProperty(at, segment, { value: created, enumerable: true, writable: true, configurable: true });
        at = created;
      }
    }
    Object.defineProperty(at, path.at(-1) as string, {
      value: structuredClone(entry.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}

/** The file's text after the taken keys are written into this machine's: its comments and order survive. */
function mergedText(
  config: ConfigText,
  path: FileDoc,
  input: CloneSettingsInput,
  root: Readonly<Record<string, unknown>>,
  taken: ReadonlyMap<string, { readonly value: unknown; readonly present: boolean }>,
): string {
  return config.edit(input.mineExists ? input.mine : undefined, merge(root, taken), root, config.modeline(path));
}

/** The most differing keys whose loosening is judged one by one; a document with more is flagged as a whole. */
const LOOSENING_JUDGED_LIMIT = 256;

/** The rows of a document whose two sides were read, or `undefined` when more keys differ than a copy merges. */
function compare(
  input: CloneSettingsInput,
  theirs: Reading,
  own: Reading,
  known: Readonly<Record<string, string>> | undefined,
):
  | {
      readonly rows: readonly Row[];
      readonly source: ReadonlyMap<string, unknown>;
      readonly theirsDigests: Readonly<Record<string, string>>;
    }
  | undefined {
  // A key one side holds as a value and the other as a mapping is compared whole, at that path.
  const structural = structuralPaths(own.values, theirs.values);
  const ours = collapse(own.values, own.root, structural);
  const source = collapse(theirs.values, theirs.root, structural);
  const keys = [...new Set([...ours.keys(), ...source.keys()])].toSorted();
  const rows: Row[] = [];
  const theirsDigests: Record<string, string> = {};
  for (const [key, value] of theirs.values) theirsDigests[key] = digestOf(value);
  for (const path of structural) if (source.has(path)) theirsDigests[path] = digestOf(source.get(path));
  for (const key of keys) {
    const here = ours.has(key) ? ours.get(key) : undefined;
    const there = source.has(key) ? source.get(key) : undefined;
    const mineDigest = ours.has(key) ? digestOf(here) : undefined;
    const theirsDigest = source.has(key) ? digestOf(there) : undefined;
    const outcome = outcomeOf(mineDigest, theirsDigest, known?.[key], known !== undefined);
    // The controls always have a value here and a source that says nothing about one has not dropped it.
    if (
      outcome === undefined ||
      (input.path === 'controls' && (outcome === 'gone' || (theirsDigest === undefined && outcome === 'both')))
    )
      continue;
    const choice = DEFAULT_CHOICE[outcome];
    rows.push({
      key,
      outcome,
      ...(choice === undefined ? {} : { choice }),
      ...(mineDigest === undefined ? {} : { mine: here }),
      ...(theirsDigest === undefined ? {} : { theirs: there }),
    });
  }
  return rows.length > CLONE_SETTINGS_KEYS_LIMIT ? undefined : { rows, source, theirsDigests };
}

/** The analysis of a document that has more differing keys than a copy merges. */
function tooManyKeys(input: CloneSettingsInput): FileAnalysis {
  return {
    input,
    rows: [],
    refused: `${input.path} has more than ${String(CLONE_SETTINGS_KEYS_LIMIT)} settings that differ, which is more than a copy merges. Leave ${input.path} out.`,
    theirsDigests: {},
    root: {},
  };
}

/** The analysis of a document that cannot be read: `read` refuses with a sentence; anything else is still a document this machine cannot take, never a crash. */
function unreadable(input: CloneSettingsInput, error: unknown): FileAnalysis {
  const refused = error instanceof CloneRefusal ? error.message : `The ${input.path} could not be read.`;
  return { input, rows: [], refused, theirsDigests: {}, root: {} };
}

/** The machine controls compared with the source's. They are JSON this package reads itself: no config layer is asked. */
function analyseControls(input: CloneSettingsInput, known: Readonly<Record<string, string>> | undefined): FileAnalysis {
  let theirs: Reading;
  try {
    theirs = readControls(input.theirs, 'The');
  } catch (error) {
    return unreadable(input, error);
  }
  const own = readControls(input.mine, 'Your');
  const compared = compare(input, theirs, own, known);
  if (compared === undefined) return tooManyKeys(input);
  const rows = compared.rows.map(row => ({ ...row, loosens: controlsLoosen(row.key, row.mine, row.theirs) }));
  return { input, rows, theirsDigests: compared.theirsDigests, root: own.root };
}

/** A settings file compared with the source's, through the config layer that reads, judges and later edits it. */
function analyseFile(
  config: ConfigText,
  path: FileDoc,
  input: CloneSettingsInput,
  known: Readonly<Record<string, string>> | undefined,
): FileAnalysis {
  let theirs: Reading;
  try {
    theirs = readFile(config, path, input.theirs, 'The');
  } catch (error) {
    return unreadable(input, error);
  }
  if (config.hasRawSecret(theirs.root)) {
    return {
      input,
      rows: [],
      refused: `${path} from the source holds a value that looks like a secret, which a configuration file never does. Fix it there, or leave ${path} out.`,
      withheld: true,
      theirsDigests: {},
      root: {},
    };
  }
  const own = input.mineExists
    ? readFile(config, path, input.mine, 'Your')
    : { values: new Map<string, unknown>(), root: {} };
  // The same refusal for this machine's own file: a value pasted into it by hand must never reach a review row,
  // a digest or a log. Nothing about it is returned but the sentence.
  if (config.hasRawSecret(own.root)) {
    return {
      input,
      rows: [],
      refused: `Your ${path} holds a value that looks like a secret, which a configuration file never does. Move it into a secret and refer to it as \${secret:NAME}, or leave ${path} out of this copy.`,
      withheld: true,
      theirsDigests: {},
      root: {},
    };
  }
  const compared = compare(input, theirs, own, known);
  if (compared === undefined) return tooManyKeys(input);
  return {
    input,
    rows: withLoosening(config, path, input, own.root, compared.source, compared.rows),
    theirsDigests: compared.theirsDigests,
    root: own.root,
    config,
  };
}

/** Each row flagged when taking it alone would loosen what this machine may spend or what its agents may do. */
function withLoosening(
  config: ConfigText,
  path: FileDoc,
  input: CloneSettingsInput,
  root: Readonly<Record<string, unknown>>,
  theirs: ReadonlyMap<string, unknown>,
  rows: readonly Row[],
): readonly Row[] {
  if (input.effective === undefined) return rows;
  if (rows.length > LOOSENING_JUDGED_LIMIT) return rows.map(row => ({ ...row, loosens: true }));
  // What this machine's own file already loosens (a held edit) is not charged to the key being taken.
  const already = looseningOf(config, path, input.effective, input.mineExists ? input.mine : '') ?? new Set<string>();
  return rows.map(row => {
    if (!KEY_CHOICES[row.outcome].includes('take')) return row;
    const taken = new Map([[row.key, { value: theirs.get(row.key), present: theirs.has(row.key) }]]);
    const sentences = looseningOf(config, path, input.effective, mergedText(config, path, input, root, taken));
    return sentences === undefined ? row : { ...row, loosens: [...sentences].some(sentence => !already.has(sentence)) };
  });
}

/**
 * Compare each settings document the source sent with this machine's. `base` is the record's per-key digests
 * for the source (`undefined` when there is no record of it). A document that cannot be read is `refused`, not
 * an error: the review says so and the apply refuses until it is left out.
 */
export function analyseCloneSettings(
  inputs: readonly CloneSettingsInput[],
  base: Readonly<Partial<Record<CloneSettingsDoc, Readonly<Record<string, string>>>>> | undefined,
  config: ConfigText | undefined,
): CloneSettingsAnalysis {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.path)) throw new CloneRefusal(`${input.path} was sent twice. Send each settings document once.`);
    seen.add(input.path);
  }
  const files = inputs.map(input => {
    if (!isFileDoc(input.path)) return analyseControls(input, base?.[input.path]);
    if (config === undefined) {
      throw new CloneRefusal('This machine cannot merge settings documents yet. Leave them out and copy the rest.');
    }
    return analyseFile(config, input.path, input, base?.[input.path]);
  });
  const fingerprint = sha256Hex(
    JSON.stringify(
      files.map(file => [
        file.input.path,
        file.input.mineExists,
        file.withheld === true ? '' : sha256Hex(file.input.mine),
        file.withheld === true ? '' : sha256Hex(file.input.theirs),
        file.refused ?? '',
        Object.entries(base?.[file.input.path] ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  );
  return { files, fingerprint };
}

/** The review's rows: every key that differs and why, what is chosen for it, and what taking it would loosen. */
export function reviewCloneSettings(analysis: CloneSettingsAnalysis): CloneReviewSettings[] {
  return analysis.files.map(file => ({
    path: file.input.path,
    ...(file.input.mineExists || file.input.path === 'controls' ? {} : { isNew: true }),
    ...(file.refused === undefined ? {} : { refused: file.refused }),
    keys: file.rows.map(row => ({
      key: row.key,
      outcome: row.outcome,
      ...(row.choice === undefined ? {} : { choice: row.choice }),
      ...(row.mine === undefined ? {} : { mine: display(row.mine) }),
      ...(row.theirs === undefined ? {} : { theirs: display(row.theirs) }),
      ...(row.loosens === true ? { loosens: true } : {}),
    })),
  }));
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────

export interface CloneSettingsPlan {
  /** Configuration files to write, in the order sent: the merged text, only where it differs from this machine's. */
  readonly files: readonly {
    readonly path: FileDoc;
    readonly text: string;
    /** The file as this machine had it (its etag is what the write is made against), `undefined` for a new file. */
    readonly previous: string | undefined;
    /** Taking the keys of this write would loosen something (the write is held unless the caller may loosen). */
    readonly loosens: boolean;
    readonly keys: readonly string[];
  }[];
  /** The controls taken: only those fields, to be applied as a smaller `machine.settings` change. */
  readonly controls?: {
    readonly taken: CloneControls;
    readonly keys: readonly string[];
    readonly widensAgentControl: boolean;
  };
  /** The source's documents after this copy (B := theirs), for the record. Only the documents the copy decided. */
  readonly recorded: Readonly<Partial<Record<CloneSettingsDoc, Readonly<Record<string, string>>>>>;
  /** What was done, by `<document>: <key>`. */
  readonly done: { readonly taken: readonly string[]; readonly kept: readonly string[] };
}

export const EMPTY_CLONE_SETTINGS_PLAN: CloneSettingsPlan = {
  files: [],
  recorded: {},
  done: { taken: [], kept: [] },
};

/**
 * What an apply writes, from the review and the person's per-key decisions. Refuses (with the sentence a person
 * reads) a document that cannot be copied, a decision about nothing the review listed, a choice an outcome does
 * not allow, and **a key both sides changed that has no decision** — nothing is chosen for the person.
 */
export function planCloneSettings(
  analysis: CloneSettingsAnalysis,
  decisions: CloneSettingsDecisions | undefined,
): CloneSettingsPlan {
  const byPath = new Map(analysis.files.map(file => [file.input.path, file]));
  for (const [path, keys] of Object.entries(decisions ?? {}) as [CloneSettingsDoc, Record<string, CloneKeyChoice>][]) {
    const file = byPath.get(path);
    if (file === undefined) throw new CloneRefusal(`There are no ${path} settings in this review to decide.`);
    for (const [key, choice] of Object.entries(keys)) {
      const row = file.rows.find(candidate => candidate.key === key);
      if (row === undefined) throw new CloneRefusal(`There is nothing called ${key} in the ${path} review.`);
      if (!KEY_CHOICES[row.outcome].includes(choice)) {
        throw new CloneRefusal(
          `${path}: ${key} can't be set to "${choice}": it can be ${KEY_CHOICES[row.outcome].map(one => `"${one}"`).join(' or ')}.`,
        );
      }
    }
  }
  const refused = analysis.files.filter(file => file.refused !== undefined);
  if (refused.length > 0) {
    throw new CloneRefusal(`${(refused[0] as FileAnalysis).refused as string} Nothing was changed.`);
  }
  const unchosen = analysis.files.flatMap(file =>
    file.rows
      .filter(row => row.outcome === 'both' && decisions?.[file.input.path]?.[row.key] === undefined)
      .map(row => `${file.input.path}: ${row.key}`),
  );
  if (unchosen.length > 0) {
    throw new CloneRefusal(
      `Both sides changed ${unchosen.join(', ')}. Choose whether to take theirs or keep yours for each one.`,
    );
  }

  const files: Array<CloneSettingsPlan['files'][number]> = [];
  let controls: CloneSettingsPlan['controls'];
  const recorded: Partial<Record<CloneSettingsDoc, Readonly<Record<string, string>>>> = {};
  const taken: string[] = [];
  const kept: string[] = [];
  for (const file of analysis.files) {
    recorded[file.input.path] = file.theirsDigests;
    const chosen = new Map<string, { value: unknown; present: boolean; loosens: boolean }>();
    for (const row of file.rows) {
      const choice = decisions?.[file.input.path]?.[row.key] ?? row.choice;
      if (choice === 'take') {
        chosen.set(row.key, { value: row.theirs, present: row.theirs !== undefined, loosens: row.loosens === true });
        taken.push(`${file.input.path}: ${row.key}`);
      } else kept.push(`${file.input.path}: ${row.key}`);
    }
    if (chosen.size === 0) continue;
    if (file.config === undefined) {
      const fields: Record<string, unknown> = {};
      const agentControl: Record<string, boolean> = {};
      let widens = false;
      for (const [key, entry] of chosen) {
        if (key.startsWith('agentControl.')) {
          agentControl[key.slice('agentControl.'.length)] = entry.value as boolean;
          if (entry.loosens) widens = true;
        } else fields[key] = entry.present ? entry.value : null;
      }
      const parsed = ControlsSchema.parse({
        ...fields,
        ...(Object.keys(agentControl).length === 0 ? {} : { agentControl }),
      });
      controls = {
        taken: parsed,
        keys: [...chosen.keys()],
        widensAgentControl: widens,
      };
      continue;
    }
    const path = file.input.path as FileDoc;
    const everyKeyOfNewFile =
      !file.input.mineExists && file.rows.every(row => chosen.has(row.key)) && file.input.theirs.trim() !== '';
    const text = everyKeyOfNewFile
      ? file.input.theirs
      : mergedText(
          file.config,
          path,
          file.input,
          file.root,
          new Map([...chosen].map(([key, entry]) => [key, { value: entry.value, present: entry.present }])),
        );
    if (file.input.mineExists && text === file.input.mine) continue;
    files.push({
      path,
      text,
      previous: file.input.mineExists ? file.input.mine : undefined,
      loosens: [...chosen.values()].some(entry => entry.loosens),
      keys: [...chosen.keys()],
    });
  }
  return {
    files,
    ...(controls === undefined ? {} : { controls }),
    recorded,
    done: { taken, kept },
  };
}
