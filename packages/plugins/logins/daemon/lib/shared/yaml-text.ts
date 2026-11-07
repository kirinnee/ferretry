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
import { type Document, isMap, isNode, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';

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

/** A syntax error, located. */
export interface ConfigSyntaxError {
  readonly message: string;
  readonly position?: TextPosition;
}

/** Read with YAML 1.2's core schema: `off` and `no` are strings, not booleans, wherever they are read. */
const PARSE_OPTIONS = { version: '1.2', uniqueKeys: true, prettyErrors: false } as const;

/** Parse one file. A document that does not parse answers its syntax errors and nothing else. */
export function readConfigText(
  text: string,
):
  | { readonly ok: true; readonly read: ReadConfigText }
  | { readonly ok: false; readonly errors: readonly ConfigSyntaxError[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  if (document.errors.length > 0) {
    return {
      ok: false,
      errors: document.errors.map(error => {
        const position = lineCounter.linePos(error.pos[0]);
        // The parser's message ends with an excerpt of the line; the location says the same thing.
        return {
          message: error.message.split('\n')[0] ?? error.message,
          position: { line: position.line, column: position.col },
        };
      }),
    };
  }
  const located = (node: unknown): TextPosition | undefined => {
    if (!isNode(node) || node.range === undefined || node.range === null) return undefined;
    const position = lineCounter.linePos(node.range[0]);
    return { line: position.line, column: position.col };
  };
  return {
    ok: true,
    read: {
      // An empty file is an empty mapping: every setting left at its default.
      value: document.toJS() ?? {},
      locate: path => {
        for (let depth = path.length; depth > 0; depth -= 1) {
          const prefix = path.slice(0, depth);
          // A key is where a person looks ("line 4: bogus"); an item in a list has no key, so its value.
          const position = located(keyNode(document, prefix)) ?? located(document.getIn(prefix as unknown[], true));
          if (position !== undefined) return position;
        }
        return located(document.contents) ?? { line: 1, column: 1 };
      },
    },
  };
}

/** The KEY node of the pair at `path`, when its parent is a mapping. */
function keyNode(document: Document, path: readonly PropertyKey[]): Node | undefined {
  const parent = path.length === 1 ? document.contents : document.getIn(path.slice(0, -1) as unknown[], true);
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find(item => isScalar(item.key) && item.key.value === path.at(-1));
  return isNode(pair?.key) ? pair.key : undefined;
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

/**
 * The text of a file after it is made to mean `target`.
 *
 * - `existing` — the file's text now, or `undefined` for a new file. A file that does not parse is
 *   replaced whole: there is no structure left to keep.
 * - `current` — what `existing` means now (for a new file: what an EMPTY file means), defaults filled
 *   in, so unchanged defaults stay unwritten.
 * - `modeline` — the `# yaml-language-server: $schema=…` line a file starts with; added when missing.
 */
export function editConfigText(
  existing: string | undefined,
  target: Record<string, unknown>,
  current: unknown,
  modeline: string,
): string {
  let document: Document = parseDocument(existing ?? '', PARSE_OPTIONS);
  if (document.errors.length > 0) document = parseDocument('', PARSE_OPTIONS);
  if (!isMap(document.contents)) document.contents = document.createNode({});
  editValue(document, [], target, current);
  // The parser attaches a comment directly above the first key to that key, not to the document, so
  // the text itself is what says whether the file starts with a modeline — the EDITED text, because
  // an edit that removes that first key removes the comment with it.
  const edited = document.toString({ lineWidth: 0 });
  if (edited.split('\n', 5).some(line => line.includes(MODELINE_MARK))) return edited;
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
  const document: Document = parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length > 0) throw new Error(`the file does not parse: ${document.errors[0]?.message ?? ''}`);
  if (document.contents === null) document.contents = document.createNode({});
  if (!isMap(document.contents)) throw new Error('the file is not a mapping of keys');
  if (value === undefined) document.delete(key);
  else document.set(key, document.createNode(value));
  return document.toString({ lineWidth: 0 });
}
