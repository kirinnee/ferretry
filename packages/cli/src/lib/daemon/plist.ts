/** A property-list value, reduced to the shapes a launchd job definition uses. */
export type PlistValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'array'; readonly items: readonly PlistValue[] }
  | { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, PlistValue> };

type Token =
  | { readonly type: 'open' | 'close' | 'empty'; readonly name: string }
  | { readonly type: 'text'; readonly value: string };

/** What `plutil -convert binary1` writes; the magic is ASCII, so it survives a UTF-8 read. */
export function isBinaryPlist(text: string): boolean {
  return text.startsWith('bplist');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/gu, (whole: string, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Split XML into tags and text, dropping the declaration, the DOCTYPE and comments.
 *
 * Markup between tags is not the tokenizer's concern: `plutil` and Xcode re-indent a plist with tabs
 * and newlines, and a CRLF checkout adds a carriage return to every line, so whitespace between
 * elements carries no meaning here and is dropped by the reader that wants only elements.
 */
function tokenize(xml: string): readonly Token[] | undefined {
  const tokens: Token[] = [];
  const source = xml.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/^﻿/u, '');
  const pattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][\w.-]*)(?:\s[^<>]*?)?(\/?)>|([^<]+)/gu;
  let consumed = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index !== consumed) return undefined;
    consumed = match.index + match[0].length;
    const [, cdata, closing, name, selfClosing, text] = match;
    if (cdata !== undefined) tokens.push({ type: 'text', value: cdata });
    else if (name !== undefined) {
      tokens.push({ type: closing === '/' ? 'close' : selfClosing === '/' ? 'empty' : 'open', name });
    } else if (text !== undefined) tokens.push({ type: 'text', value: decodeEntities(text) });
  }
  return consumed === source.length ? tokens : undefined;
}

/** A recursive reader over the token list; every method answers `undefined` for input it cannot read. */
class Reader {
  #position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** Skip whitespace-only text; any other text is not valid between elements. */
  #next(): Token | undefined {
    for (;;) {
      const token = this.tokens[this.#position];
      this.#position += 1;
      if (token?.type !== 'text' || token.value.trim() !== '') return token;
    }
  }

  /** The text up to the matching close tag, which is consumed. */
  #text(name: string): string | undefined {
    let value = '';
    for (;;) {
      const token = this.tokens[this.#position];
      this.#position += 1;
      if (token?.type === 'text') value += token.value;
      else if (token?.type === 'close' && token.name === name) return value;
      else return undefined;
    }
  }

  value(first: Token | undefined = this.#next()): PlistValue | undefined {
    if (first === undefined || first.type === 'text' || first.type === 'close') return undefined;
    const { name } = first;
    if (first.type === 'empty') return this.#empty(name);
    switch (name) {
      case 'dict':
        return this.#dict();
      case 'array':
        return this.#array();
      case 'string':
      case 'data':
      case 'date': {
        const text = this.#text(name);
        return text === undefined ? undefined : { kind: 'string', value: text };
      }
      case 'integer':
      case 'real': {
        const text = this.#text(name)?.trim();
        const number = text === undefined || text === '' ? Number.NaN : Number(text);
        return Number.isNaN(number) ? undefined : { kind: 'number', value: number };
      }
      default:
        return undefined;
    }
  }

  #empty(name: string): PlistValue | undefined {
    switch (name) {
      case 'true':
        return { kind: 'boolean', value: true };
      case 'false':
        return { kind: 'boolean', value: false };
      case 'string':
      case 'data':
      case 'date':
        return { kind: 'string', value: '' };
      case 'array':
        return { kind: 'array', items: [] };
      case 'dict':
        return { kind: 'dict', entries: new Map() };
      default:
        return undefined;
    }
  }

  #array(): PlistValue | undefined {
    const items: PlistValue[] = [];
    for (;;) {
      const token = this.#next();
      if (token?.type === 'close') return token.name === 'array' ? { kind: 'array', items } : undefined;
      const item = this.value(token);
      if (item === undefined) return undefined;
      items.push(item);
    }
  }

  #dict(): PlistValue | undefined {
    const entries = new Map<string, PlistValue>();
    for (;;) {
      const token = this.#next();
      if (token?.type === 'close') return token.name === 'dict' ? { kind: 'dict', entries } : undefined;
      if (token?.type !== 'open' || token.name !== 'key') return undefined;
      const key = this.#text('key');
      const entry = key === undefined ? undefined : this.value();
      if (key === undefined || entry === undefined) return undefined;
      entries.set(key, entry);
    }
  }

  /** `true` once only whitespace remains. */
  finished(): boolean {
    return this.#next() === undefined;
  }
}

/**
 * Read an XML property list, in any layout `plutil`, Xcode or a CRLF checkout produces: whitespace and
 * newlines between tags, any key order, an XML declaration, a DOCTYPE, comments and CDATA.
 *
 * Total: `undefined` for anything that is not a well-formed XML plist (including a binary one, which
 * {@link isBinaryPlist} names so the caller can convert it first). The top level may be a bare value
 * or wrapped in `<plist>`.
 */
export function parsePlist(xml: string): PlistValue | undefined {
  const tokens = tokenize(xml);
  if (tokens === undefined) return undefined;
  const reader = new Reader(tokens);
  const first = tokens.find(token => token.type !== 'text' || token.value.trim() !== '');
  if (first?.type === 'open' && first.name === 'plist') {
    const body = new Reader(unwrapPlist(tokens));
    const value = body.value();
    return value !== undefined && body.finished() ? value : undefined;
  }
  const value = reader.value();
  return value !== undefined && reader.finished() ? value : undefined;
}

/** The tokens between `<plist>` and `</plist>`; an unclosed wrapper yields a stream that fails to read. */
function unwrapPlist(tokens: readonly Token[]): readonly Token[] {
  const start = tokens.findIndex(token => token.type === 'open' && token.name === 'plist');
  const end = tokens.findLastIndex(token => token.type === 'close' && token.name === 'plist');
  return end > start ? tokens.slice(start + 1, end) : [];
}

/** The string at `path` through nested dictionaries, or `undefined` when any step is missing or not that shape. */
export function plistString(root: PlistValue | undefined, ...path: readonly string[]): string | undefined {
  let current = root;
  for (const key of path) {
    if (current?.kind !== 'dict') return undefined;
    current = current.entries.get(key);
  }
  return current?.kind === 'string' ? current.value : undefined;
}
