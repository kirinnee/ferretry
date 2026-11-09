/**
 * A configuration file's TEXT: read with every problem located to a line and column, and edited so
 * that only the changed keys are rewritten and the owner's comments and key order survive.
 *
 * The files are edited by people. A file a program rewrote from scratch would lose every comment the
 * owner wrote the first time the app saved a toggle, and the owner would stop writing them — so every
 * write goes through {@link editConfigText}, which changes a key only where the value really differs
 * and leaves everything else, comments included, byte for byte. That is why this uses the `yaml`
 * package's Document API rather than `Bun.YAML`, which has no comments to keep.
 *
 * Pure: text in, text out.
 */
import {
  type Alias,
  type Document,
  type ErrorCode,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

/** The folder the generated JSON Schemas go in (`config/.schema/`); never a config path. The kernel's claims re-export it. */
export const SCHEMA_FOLDER = '.schema';

/**
 * The most a configuration file may hold, in UTF-8 bytes (today's `CONFIG_FILE_MAX_BYTES`). It is checked BEFORE
 * anything reads the text — the parser, the alias walk, the raw-secret scan — at every door that hands a text in: the
 * disk read at boot and reload, an accepted record read back, `config_read`, `config_validate` and `config_write`.
 * Every cost below is then bounded by it: a file over it is refused in one fixed sentence and never parsed.
 */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

/** What a text over {@link CONFIG_FILE_MAX_BYTES} is told, in a FIXED sentence: nothing of the text. */
export const CONFIG_TOO_LARGE = `the file is larger than the ${String(CONFIG_FILE_MAX_BYTES / 1024)} KiB a configuration file may be`;

/**
 * Whether `text` is over {@link CONFIG_FILE_MAX_BYTES} in UTF-8. Bounded whatever the text: a string longer than the cap
 * in UTF-16 units is over it (every unit is at least one byte), and a shorter one is counted, stopping at the cap.
 */
export function configTextTooLarge(text: string): boolean {
  if (text.length > CONFIG_FILE_MAX_BYTES) return true;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    // A surrogate pair is 4 bytes, 2 per unit; the rest of the BMP is 1–3.
    bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 2 : 3;
    if (bytes > CONFIG_FILE_MAX_BYTES) return true;
  }
  return false;
}

/**
 * The most `%` directive lines a file may hold. The parser costs about 7 µs for every one (a 256 KiB file of bare `%`
 * lines is 131 072 of them and took a second and a half), and no configuration file needs more than the one or two
 * YAML itself has directives for: past this many, the file is refused in the fixed sentence for a directive, without
 * being parsed.
 */
const MAX_DIRECTIVE_LINES = 64;

/** A `%` at the start of a line, in any of the line endings YAML knows. */
const DIRECTIVE_LINE = /(?:^|[\r\n])%/gu;

/**
 * The line of the first `%` directive past {@link MAX_DIRECTIVE_LINES}, or `undefined` when the text has no more than
 * that. One scan that stops at the first excess line, so it costs the text, never the parser's per-line price.
 */
function directiveFlood(text: string): number | undefined {
  let seen = 0;
  for (const match of text.matchAll(DIRECTIVE_LINE)) {
    seen += 1;
    if (seen <= MAX_DIRECTIVE_LINES) continue;
    const at = match.index + match[0].length - 1;
    return text.slice(0, at).split(/\r\n|\r|\n/u).length;
  }
  return undefined;
}

/** A 1-based place in a file. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/** A file read: its plain value, and how to find where a path inside it is written. */
export interface ReadConfigText {
  readonly value: unknown;
  /** Where `path` is written — or the deepest part of it that is, so a missing key points at its parent. */
  locate(path: readonly PropertyKey[]): TextPosition | undefined;
}

/**
 * The most syntax errors one read lists. The rest are counted ({@link ConfigTextRefusal.omitted}), never built: a text
 * of 256 KiB can hold a hundred thousand parser errors, and locating each one before an answer keeps fifty cost a second
 * of garbage.
 */
export const MAX_SYNTAX_ERRORS = 50;

/** A text that did not read: its first {@link MAX_SYNTAX_ERRORS} errors, and how many more there were. */
interface ConfigTextRefusal {
  readonly ok: false;
  readonly errors: readonly ConfigSyntaxError[];
  /** Errors past {@link MAX_SYNTAX_ERRORS}, counted and not listed; absent when every error is listed. */
  readonly omitted?: number;
}

/** A syntax error, located. */
interface ConfigSyntaxError {
  readonly message: string;
  readonly position?: TextPosition;
}

/**
 * Read with YAML 1.2's core schema: `off` and `no` are strings, not booleans, wherever they are read. A key written
 * twice is still refused, by {@link duplicateKeys}: the parser's own check compares every key with every key before it
 * in the same mapping, so one flat mapping of a few hundred KiB would take seconds to read.
 *
 * `resolveKnownTags: false`: a YAML 1.1 tag (`!!omap`, `!!set`, `!!pairs`, `!!binary`, `!!timestamp`) is NOT
 * resolved while the text is parsed — its value is read as the plain list, mapping or string it is written as, like any
 * other tag this file cannot use. The library resolves those tags inside the parse, before anything here can bound
 * them, and its `!!omap` check compares every key with every key before it: 256 KiB of one took seconds. No
 * configuration value is a Set, a Map, bytes or a Date (each is JSON-shaped), so nothing a file means is lost; the core
 * tags (`!!str`, `!!int`, …) still resolve.
 */
const PARSE_OPTIONS = {
  version: '1.2',
  uniqueKeys: false,
  resolveKnownTags: false,
  prettyErrors: false,
  logLevel: 'error',
} as const;

/** What an alias that cannot be read is, in words that never name the alias: a name can be anything a person typed. */
const ALIAS_UNRESOLVED = 'an alias (*name) names an anchor (&name) that is not set before it';
const ALIAS_LOOP = 'an alias (*name) sits inside the anchor (&name) it names, so its value never ends';
const ALIAS_EXCESSIVE = 'the aliases (*name) in this file expand too far to read';

/**
 * How far aliases may expand a file, in CHARACTERS: its value, every alias read out in full, may weigh this much plus
 * {@link ALIAS_EXPANSION_FACTOR} per character of its text, where a value weighs 1 and a string 1 more per character.
 * A file without aliases weighs at most about 2 per character (a value takes at least one character to write, a string
 * at least its own length), and re-using a block a few times stays far inside it; an alias bomb multiplies at every
 * step and leaves it after a few — and so does one long string aliased many times, which counting values alone missed
 * (one 128 KiB string times 18 000 aliases was "18 000 values", and gigabytes once read out).
 */
const ALIAS_EXPANSION_FLOOR = 10_000;
const ALIAS_EXPANSION_FACTOR = 2;

/**
 * What each thing the parser refuses is, in a FIXED sentence. The parser's own words quote the file — a tag, an
 * anchor, an alias, an escape, a key — and a file can hold a key pasted by mistake, so they never leave this module:
 * an issue is one of these sentences and a line number, never a word of the file.
 */
const SYNTAX_SENTENCES: Readonly<Record<ErrorCode, string>> = {
  ALIAS_PROPS: 'an alias (*name) cannot carry an anchor or a tag',
  BAD_ALIAS: 'an alias or anchor name is empty or ends in a colon',
  BAD_COLLECTION_TYPE: 'a tag names a kind of collection that does not match the value',
  BAD_DIRECTIVE: 'a % directive line is not one YAML knows',
  BAD_DQ_ESCAPE: 'a double-quoted value holds an escape (\\) that is not valid',
  BAD_INDENT: 'the indentation is wrong',
  BAD_PROP_ORDER: 'an anchor or tag is in the wrong place',
  BAD_SCALAR_START: 'a plain value starts with a character that must be quoted',
  BLOCK_AS_IMPLICIT_KEY: 'a block value is used as a key',
  BLOCK_IN_FLOW: 'a block value sits inside [ ] or { }',
  DUPLICATE_KEY: 'a key is written twice in the same mapping',
  IMPOSSIBLE: 'the text cannot be read as YAML',
  KEY_OVER_1024_CHARS: 'a key is longer than 1024 characters',
  MISSING_CHAR: 'a closing quote, bracket or brace is missing',
  MULTILINE_IMPLICIT_KEY: 'a key runs over more than one line',
  MULTIPLE_ANCHORS: 'a value has more than one anchor (&name)',
  MULTIPLE_DOCS: 'the file holds more than one document (---)',
  MULTIPLE_TAGS: 'a value has more than one tag',
  NON_STRING_KEY: 'a key is not a plain string',
  RESOURCE_EXHAUSTION: 'the file is too deeply nested or too large to read',
  TAB_AS_INDENT: 'a tab is used for indentation; use spaces',
  TAG_RESOLVE_FAILED: 'a tag (!name) is not one this file can use, or its value does not fit it',
  UNEXPECTED_TOKEN: 'there is something here the YAML grammar does not expect',
};
const SYNTAX_UNKNOWN = 'the text cannot be read as YAML';

/**
 * Every key written a second time in its mapping, in text order, by the parser's own rule (two keys are the same when
 * both are scalars with the same value) — but each mapping's keys go through one set, so the cost is linear.
 */
function duplicateKeys(document: Document): readonly Node[] {
  const found: Node[] = [];
  const pending: unknown[] = [document.contents];
  while (pending.length > 0) {
    const node = pending.pop();
    if (isPair(node)) {
      pending.push(node.value, node.key);
      continue;
    }
    if (!isCollection(node)) continue;
    if (isMap(node)) {
      const seen = new Set<unknown>();
      for (const { key } of node.items) {
        // NaN is not equal to itself, so the parser never calls two `.nan` keys the same.
        if (!isScalar(key) || Number.isNaN(key.value)) continue;
        if (seen.has(key.value)) found.push(key);
        else seen.add(key.value);
      }
    }
    for (let index = node.items.length - 1; index >= 0; index -= 1) pending.push(node.items[index]);
  }
  return found.sort((left, right) => (left.range?.[0] ?? 0) - (right.range?.[0] ?? 0));
}

/** Why a file's aliases cannot be read, and where. */
interface AliasFault {
  readonly message: string;
  readonly at: Node | undefined;
}

/** A collection's turn on the walk: entered (anchor recorded, items queued) or left (its expanded size totted up). */
type Step = { readonly node: unknown; readonly leaving: false } | { readonly node: Collection; readonly leaving: true };

type Collection = YAMLMap | YAMLSeq;

/**
 * Every alias in `document` resolved in ONE walk in document order — or the first one that cannot be read.
 *
 * The walk is the library's order (a node before its items, a pair's key before its value), and an anchor is recorded
 * when its node is entered, so the anchor an alias resolves to is the last one recorded by then: exactly the one the
 * library would pick. Then:
 * - no anchor recorded under its name: the alias is unresolved;
 * - its anchor's node is still open (the alias sits inside it): the alias loops. This is the ONLY way a value can reach
 *   itself — any other anchor an alias names was closed before the alias began, so following aliases only ever moves
 *   to text that ends earlier, and cannot come back;
 * - the value, every alias read out, weighs more than the expansion budget: the aliases expand too far. A collection is
 *   totted up when it is left, from the weights of its items, which are known by then — an alias's is its anchor's;
 * - a key is a mapping or a list (or an alias to one): refused as a key that is not a plain string.
 *
 * Each node is entered once and left once and each alias looked up once, so the cost is linear in the file. The
 * library's own alias resolution is not: it walks the whole document again for each alias, so it is never asked to.
 */
function resolveAliases(
  document: Document,
  characters: number,
):
  | { readonly ok: true; readonly targets: ReadonlyMap<Alias, Node> }
  | { readonly ok: false; readonly fault: AliasFault } {
  const anchors = new Map<string, Node>();
  const open = new Set<Node>();
  const targets = new Map<Alias, Node>();
  /** Each closed collection's weight with every alias read out; a scalar is 1, and a string 1 more per character. */
  const expanded = new Map<Node, number>();
  const sizeOf = (item: unknown): number => {
    if (isPair(item)) return sizeOf(item.key) + sizeOf(item.value);
    if (isAlias(item)) return sizeOf(targets.get(item));
    if (isCollection(item)) return expanded.get(item) ?? 0;
    if (!isScalar(item)) return 0;
    return 1 + (typeof item.value === 'string' ? item.value.length : 0);
  };
  const budget = ALIAS_EXPANSION_FLOOR + ALIAS_EXPANSION_FACTOR * characters;
  const steps: Step[] = [{ node: document.contents, leaving: false }];
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    const { node } = step;
    if (step.leaving) {
      let total = 1;
      for (const item of step.node.items) {
        total += sizeOf(item);
        if (total > budget) return { ok: false, fault: { message: ALIAS_EXCESSIVE, at: firstNodeOf(item) } };
      }
      expanded.set(step.node, total);
      open.delete(step.node);
      continue;
    }
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      if (target === undefined) return { ok: false, fault: { message: ALIAS_UNRESOLVED, at: node } };
      if (open.has(target)) return { ok: false, fault: { message: ALIAS_LOOP, at: node } };
      targets.set(node, target);
    } else if (isPair(node)) {
      // A key that is a mapping or a list (written, or an alias to one) is refused here, before the value is built: no
      // configuration value can hold one (it is JSON-shaped), and the library would stringify each such key with a copy
      // of every anchor in the document, which costs anchors × keys.
      const { key } = node;
      if (isCollection(key)) return { ok: false, fault: { message: SYNTAX_SENTENCES.NON_STRING_KEY, at: key } };
      if (isAlias(key)) {
        // An alias key to a collection still open is a loop, and is said as one when the alias itself is reached.
        const target = anchors.get(key.source);
        if (isCollection(target) && !open.has(target))
          return { ok: false, fault: { message: SYNTAX_SENTENCES.NON_STRING_KEY, at: key } };
      }
      steps.push({ node: node.value, leaving: false }, { node: node.key, leaving: false });
    } else if (isNode(node)) {
      if (node.anchor !== undefined) anchors.set(node.anchor, node);
      if (isCollection(node)) {
        open.add(node);
        steps.push({ node, leaving: true });
        for (let index = node.items.length - 1; index >= 0; index -= 1) {
          steps.push({ node: node.items[index], leaving: false });
        }
      }
    }
  }
  return { ok: true, targets };
}

/** An item's first node, for a position: a pair's key when it is written, else its value. */
function firstNodeOf(item: unknown): Node | undefined {
  if (isPair(item)) return isNode(item.key) ? item.key : isNode(item.value) ? item.value : undefined;
  return isNode(item) ? item : undefined;
}

/** An alias error, at the node it names when there is one, else at the top of the file. */
function aliasError(lineCounter: LineCounter, fault: AliasFault): ConfigSyntaxError {
  const start = fault.at?.range?.[0];
  const position = start === undefined ? { line: 1, col: 1 } : lineCounter.linePos(start);
  return { message: fault.message, position: { line: position.line, column: position.col } };
}

/**
 * Parse one file. A document that does not parse answers its syntax errors and nothing else — and so does one whose
 * aliases cannot be read (an alias to an anchor that is not set, an alias inside its own anchor, or too many): a
 * broken file is refused and its last good version stays in effect, it never throws into a reload.
 */
export function readConfigText(text: string): { readonly ok: true; readonly read: ReadConfigText } | ConfigTextRefusal {
  return readText(text).read;
}

type ConfigTextRead = ReturnType<typeof readConfigText>;

/**
 * A file read to be edited: its read, and the text an edit of it starts from — `undefined` when
 * {@link editConfigText} would replace it whole (over the cap, not YAML, or a key written twice), so the edit need
 * not parse it a second time to find that out. One parse, where reading then editing a broken file took two.
 */
export function readConfigTextToEdit(text: string): {
  readonly read: ConfigTextRead;
  readonly base: string | undefined;
} {
  const { read, whole } = readText(text);
  return { read, base: whole ? undefined : text };
}

/** One read; `whole` says the text has no structure an edit could keep. */
function readText(text: string): { readonly read: ConfigTextRead; readonly whole: boolean } {
  // Bounded before anything reads it: every cost below is linear in a text this size.
  if (configTextTooLarge(text)) return { read: { ok: false, errors: [{ message: CONFIG_TOO_LARGE }] }, whole: true };
  const flood = directiveFlood(text);
  if (flood !== undefined) {
    // Refused before the parser sees it: it would take a second and a half to say the same thing at every one.
    return {
      whole: true,
      read: { ok: false, errors: [{ message: SYNTAX_SENTENCES.BAD_DIRECTIVE, position: { line: flood, column: 1 } }] },
    };
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  if (document.errors.length > 0) {
    // Only the errors that are listed are located: the rest are counted.
    const listed = document.errors.slice(0, MAX_SYNTAX_ERRORS).map(error => {
      const position = lineCounter.linePos(error.pos[0]);
      // Never the parser's own message: it quotes the file.
      return {
        message: SYNTAX_SENTENCES[error.code] ?? SYNTAX_UNKNOWN,
        position: { line: position.line, column: position.col },
      };
    });
    const omitted = document.errors.length - listed.length;
    return {
      whole: true,
      read: omitted === 0 ? { ok: false, errors: listed } : { ok: false, errors: listed, omitted },
    };
  }
  const duplicates = duplicateKeys(document);
  if (duplicates.length > 0) {
    return {
      whole: true,
      read: {
        ok: false,
        errors: duplicates.map(key => {
          const position = lineCounter.linePos(key.range?.[0] ?? 0);
          return { message: SYNTAX_SENTENCES.DUPLICATE_KEY, position: { line: position.line, column: position.col } };
        }),
      },
    };
  }
  return { whole: false, read: readParsed(document, lineCounter, text) };
}

/** The value of a document that parsed, its aliases resolved within the budget, and how to locate a path in it. */
function readParsed(document: Document, lineCounter: LineCounter, text: string): ConfigTextRead {
  const located = (node: unknown): TextPosition | undefined => {
    if (!isNode(node) || node.range === undefined || node.range === null) return undefined;
    const position = lineCounter.linePos(node.range[0]);
    return { line: position.line, column: position.col };
  };
  // Every alias is resolved here, in one linear walk, BEFORE the value is built: the library's own resolution is
  // quadratic, and its count of aliases has a blind spot (an anchor whose items alias an empty one counts as nothing).
  const aliases = resolveAliases(document, text.length);
  if (!aliases.ok) return { ok: false, errors: [aliasError(lineCounter, aliases.fault)] };
  for (const [alias, target] of aliases.targets) {
    // The library would look each alias up again, walking the whole document every time: hand it the answer instead.
    alias.resolve = () => target as ReturnType<Alias['resolve']>;
  }
  // The walk above has bounded the expansion, so the library's own count (and its walk per anchor) is switched off.
  // An empty file is an empty mapping: every setting left at its default.
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: -1 }) ?? {};
  } catch {
    // Not expected once every alias is resolved; if the library throws anyway, the file is refused, not the reload.
    return { ok: false, errors: [{ message: SYNTAX_UNKNOWN, position: { line: 1, column: 1 } }] };
  }
  const pairs = pairIndex();
  return {
    ok: true,
    read: {
      value,
      locate: path => {
        // Walked down from the top, one step per part: each mapping's keys are indexed once, the first time a path
        // goes through it, so locating every issue of a file costs the depth of each path, never the width of the
        // mappings on it (a lookup that scanned the keys made 20 000 issues in one mapping cost seconds).
        let node: unknown = document.contents;
        let deepest = located(node) ?? { line: 1, column: 1 };
        for (const part of path) {
          let next: unknown;
          if (isMap(node)) {
            const pair = pairs(node, part);
            if (pair === undefined) break;
            // A key is where a person looks ("line 4: bogus"); an item in a list has no key, so its value.
            deepest = located(pair.key) ?? located(pair.value) ?? deepest;
            next = pair.value;
          } else if (isSeq(node)) {
            const index = itemIndex(part);
            next = index === undefined ? undefined : node.items[index];
            if (next === undefined) break;
            deepest = located(next) ?? deepest;
          } else break;
          node = next;
        }
        return deepest;
      },
    },
  };
}

type MapPair = YAMLMap['items'][number];

/**
 * A lookup of a mapping's pair by its key, as the library's `getIn` finds it (the first pair whose key is a scalar of
 * that value), built for a mapping the first time it is asked about and kept: one pass over its keys, ever.
 */
function pairIndex(): (map: YAMLMap, key: PropertyKey) => MapPair | undefined {
  const indexes = new Map<YAMLMap, Map<unknown, MapPair>>();
  return (map, key) => {
    let index = indexes.get(map);
    if (index === undefined) {
      index = new Map();
      for (const pair of map.items) {
        if (isScalar(pair.key) && !index.has(pair.key.value)) index.set(pair.key.value, pair);
      }
      indexes.set(map, index);
    }
    return index.get(key);
  };
}

/** A list index the way the library reads one: a whole number, or a string of one, not below zero. */
function itemIndex(part: PropertyKey): number | undefined {
  const index = typeof part === 'string' && part !== '' ? Number(part) : part;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural equality over plain JSON-shaped values. */
export function sameConfigValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameConfigValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
    return leftKeys.length === rightKeys.length && leftKeys.every(key => sameConfigValue(left[key], right[key]));
  }
  return false;
}

/**
 * Rewrite the value at `path` so it means `target`, touching only what differs.
 *
 * `current` is what that value means NOW, defaults filled in, so a key the file leaves out because its
 * default already equals the target is not written in. A key the target no longer has is removed. A
 * mapping is edited key by key, a sequence item by item and a scalar in place, so a comment beside —
 * or on the same line as — anything that is kept stays exactly where it was.
 */
function editValue(document: Document, path: readonly (string | number)[], target: unknown, current: unknown): void {
  const existing = path.length === 0 ? document.contents : document.getIn(path, true);
  if (isPlainObject(target) && isMap(existing)) {
    const now = isPlainObject(current) ? current : {};
    for (const item of [...existing.items]) {
      const key = isScalar(item.key) ? item.key.value : item.key;
      if (typeof key === 'string' && target[key] === undefined) existing.delete(key);
    }
    for (const [key, value] of Object.entries(target)) {
      if (value === undefined || sameConfigValue(now[key], value)) continue;
      editValue(document, [...path, key], value, now[key]);
    }
    return;
  }
  if (Array.isArray(target) && isSeq(existing)) {
    const now = Array.isArray(current) ? current : [];
    target.forEach((value, index) => {
      if (index >= existing.items.length) existing.add(document.createNode(value));
      else if (!sameConfigValue(now[index], value)) editValue(document, [...path, index], value, now[index]);
    });
    existing.items.splice(target.length);
    return;
  }
  if (isScalar(existing) && !isPlainObject(target) && !Array.isArray(target)) {
    existing.value = target;
    return;
  }
  document.setIn(path, document.createNode(target));
}

/** The modeline every file starts with, and how to tell one is already there. */
const MODELINE_MARK = 'yaml-language-server:';
/** A modeline of the exact shape the kernel writes: a schema under `.schema/` reached by `../` steps. */
const KERNEL_MODELINE = new RegExp(
  `^# yaml-language-server: \\$schema=(?:\\.\\./)*${SCHEMA_FOLDER.replace('.', '\\.')}/[A-Za-z0-9._-]+\\.json[ \\t]*$`,
  'u',
);

/**
 * The text of a file after it is made to mean `target`.
 *
 * - `existing` — the file's text now, or `undefined` for a new file. A file that does not parse is
 *   replaced whole: there is no structure left to keep.
 * - `current` — what `existing` means now (for a new file: what an EMPTY file means), defaults filled
 *   in, so unchanged defaults stay unwritten.
 * - `modeline` — the `# yaml-language-server: $schema=…` line a file starts with; added when missing, refreshed when it
 *   is one the kernel wrote (`../.schema/<name>.json`) naming another schema, kept when it is the owner's own, and left
 *   out when `undefined`.
 */
export function editConfigText(
  existing: string | undefined,
  target: Record<string, unknown>,
  current: unknown,
  modeline: string | undefined,
): string {
  // A text over the cap, or with a flood of directives, is never parsed: like one that does not parse, it is replaced whole.
  const readable = existing !== undefined && !configTextTooLarge(existing) && directiveFlood(existing) === undefined;
  let document: Document = parseDocument(readable ? existing : '', PARSE_OPTIONS);
  if (document.errors.length > 0 || duplicateKeys(document).length > 0) document = parseDocument('', PARSE_OPTIONS);
  if (!isMap(document.contents)) document.contents = document.createNode({});
  editValue(document, [], target, current);
  // The parser attaches a comment directly above the first key to that key, not to the document, so
  // the text itself is what says whether the file starts with a modeline — the EDITED text, because
  // an edit that removes that first key removes the comment with it.
  const edited = document.toString({ lineWidth: 0 });
  if (modeline === undefined) return edited;
  const lines = edited.split('\n');
  const at = lines.slice(0, 5).findIndex(line => line.includes(MODELINE_MARK));
  if (at >= 0) {
    // A pointer the kernel itself wrote to a schema name it now publishes for another file or for none (a home from
    // before collections published `<name>--item.json`) is refreshed on this write; any other pointer is the owner's.
    if (lines[at] === modeline || !KERNEL_MODELINE.test(lines[at] ?? '')) return edited;
    lines[at] = modeline;
    return lines.join('\n');
  }
  const header = document.commentBefore ?? '';
  const line = modeline.replace(/^#/u, '');
  document.commentBefore = header === '' ? line : `${line}\n${header}`;
  return document.toString({ lineWidth: 0 });
}

/**
 * The text of a file with ONE top-level key set to `value`, or removed when `value` is `undefined` —
 * every other key, and every comment, exactly as it was. Throws when the text does not parse or is not a
 * mapping: a file nobody can read is fixed by a person, not overwritten by a verb.
 */
export function setConfigKey(text: string, key: string, value: unknown): string {
  if (configTextTooLarge(text)) throw new Error(`the file does not parse: ${CONFIG_TOO_LARGE}`);
  if (directiveFlood(text) !== undefined) throw new Error(`the file does not parse: ${SYNTAX_SENTENCES.BAD_DIRECTIVE}`);
  const document: Document = parseDocument(text, PARSE_OPTIONS);
  // The parser's message quotes the file; the line is enough for a person to find it.
  const error = document.errors[0];
  if (error !== undefined)
    throw new Error(`the file does not parse: ${SYNTAX_SENTENCES[error.code] ?? SYNTAX_UNKNOWN}`);
  if (duplicateKeys(document).length > 0) throw new Error(`the file does not parse: ${SYNTAX_SENTENCES.DUPLICATE_KEY}`);
  if (document.contents === null) document.contents = document.createNode({});
  if (!isMap(document.contents)) throw new Error('the file is not a mapping of keys');
  if (value === undefined) document.delete(key);
  else document.set(key, document.createNode(value));
  return document.toString({ lineWidth: 0 });
}
