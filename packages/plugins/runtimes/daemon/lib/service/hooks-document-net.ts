/**
 * The hooks net: a hooks file is a JSON document, and the write rule judges it by its PARSED values (`findRawSecrets` and
 * `findFlagSecrets` over the object), so `{"command": "tool --token <v>"}` and `{"args": ["--token", "<v>"]}` are
 * refused though no single LINE of the text holds a token shape. This reads the same document the same way and answers
 * which LINES of the text the refused paths stand on, so the caller can withhold exactly those.
 *
 * A refused path is mapped to the lines of its MEMBER (its key and its value, to the last line of the value); a
 * refused list item, or a word of a list the flag rule read together, withholds the whole LIST (the pair `--token`,
 * `<v>` spans two lines and the list is one command line to the rule); a secret-shaped KEY withholds its member.
 *
 * Linear in the text: the document is parsed once, the refused paths are put in a trie, and one left-to-right scan
 * walks the text with the trie beside it, so a node off every refused path costs nothing more than reading it. A
 * document nested deeper than {@link MAX_DEPTH} is not scanned: when it holds a refusal its whole text is withheld.
 */
import { findFlagSecrets, findRawSecrets } from '@ferretry/std/credential-words';

/** The deepest nesting the scan follows; past it a refused document is withheld whole. */
const MAX_DEPTH = 200;

/** What the net says: the lines (0-based) to withhold, `'whole'` for every line, or none. */
export type RefusedHooksLines = ReadonlySet<number> | 'whole';

interface Trie {
  hit: boolean;
  readonly children: Map<string, Trie>;
}

const newTrie = (): Trie => ({ hit: false, children: new Map() });

/** The trie of the paths to withhold: a list item stands for its whole list, so its path stops at the list. */
function targetsOf(document: unknown): Trie | undefined {
  const paths: (readonly (string | number)[])[] = [];
  for (const finding of findRawSecrets(document)) {
    // A secret-shaped key is refused at its object: the member holding it is the target.
    paths.push(finding.atKey ?? finding.path);
  }
  for (const finding of findFlagSecrets(document)) paths.push(finding.path);
  if (paths.length === 0) return undefined;
  const root = newTrie();
  for (const path of paths) {
    const last = path.at(-1);
    const target = typeof last === 'number' ? path.slice(0, -1) : path;
    let node = root;
    for (const segment of target) {
      const key = JSON.stringify(segment);
      let child = node.children.get(key);
      if (child === undefined) {
        child = newTrie();
        node.children.set(key, child);
      }
      node = child;
    }
    node.hit = true;
  }
  return root;
}

class TooDeep extends Error {}

/**
 * The 0-based lines of `text` (a valid JSON document, cut at `\n` only, as the line net cuts it) that the refused
 * paths of `document` stand on.
 */
function linesOf(text: string, targets: Trie): Set<number> {
  const found = new Set<number>();
  let at = 0;
  let line = 0;
  const skipBlanks = (): void => {
    while (at < text.length) {
      const character = text.charAt(at);
      if (character === '\n') line += 1;
      else if (character !== ' ' && character !== '\t' && character !== '\r') return;
      at += 1;
    }
  };
  const stringEnd = (): void => {
    // `at` is on the opening quote; a JSON string holds no raw line break.
    at += 1;
    while (at < text.length && text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1;
    at += 1;
  };
  const mark = (from: number, to: number): void => {
    for (let index = from; index <= to; index += 1) found.add(index);
  };
  const value = (node: Trie | undefined, depth: number, from: number): void => {
    if (depth > MAX_DEPTH) throw new TooDeep();
    const character = text.charAt(at);
    if (character === '{') {
      at += 1;
      for (;;) {
        skipBlanks();
        if (text.charAt(at) === '}') break;
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        const keyLine = line;
        const keyStart = at;
        stringEnd();
        const key = JSON.parse(text.slice(keyStart, at)) as string;
        skipBlanks();
        at += 1; // the colon
        skipBlanks();
        const child = node?.children.get(JSON.stringify(key));
        value(child, depth + 1, keyLine);
      }
      at += 1;
    } else if (character === '[') {
      at += 1;
      let index = 0;
      for (;;) {
        skipBlanks();
        if (text.charAt(at) === ']') break;
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        value(node?.children.get(JSON.stringify(index)), depth + 1, line);
        index += 1;
      }
      at += 1;
    } else if (character === '"') stringEnd();
    else while (at < text.length && !',]} \t\r\n'.includes(text.charAt(at))) at += 1;
    if (node?.hit === true) mark(from, line);
  };
  skipBlanks();
  value(targets, 0, line);
  return found;
}

/**
 * The lines of a hooks `text` that its parsed document's refused paths stand on; `undefined` when the text is not a
 * JSON document (the caller keeps the line net alone) or nothing in it is refused.
 */
export function hooksDocumentRefusedLines(text: string): RefusedHooksLines | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const targets = targetsOf(document);
  if (targets === undefined) return undefined;
  try {
    return linesOf(text, targets);
  } catch {
    // `TooDeep` is the only thing `linesOf` throws: the text parsed as JSON above, so the scan's own reads (a key
    // string, a bracket) cannot fail, and the depth is capped so the stack cannot overflow. Any failure withholds whole.
    return 'whole';
  }
}
