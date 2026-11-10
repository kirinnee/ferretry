/**
 * R223 — THERE IS NO PLAIN-HTTP DEVICE PATH. Every call Connections' app half makes to a daemon rides the shell's
 * sealed session (`ctx.client`, or a socket the shell hands it); the only HTTP it ever performs is the public hosted
 * directory read, through the fetcher the shell INJECTS (`ports.directory`). So no file under `app/` may reach the
 * global `fetch`, an `XMLHttpRequest`, a beacon, an `EventSource` or a socket it built itself: a bare call there would
 * be a path to a daemon that no session seals and no device proves.
 *
 * A source scan, because the guarantee is about what the code CAN reach, not about what one run happened to call. The
 * global `fetch` is found by RESOLVING IT IN THE SYNTAX TREE (cb4 F1, row 126), not by matching text: any reference to the
 * identifier `fetch`, any reach for the property on a global object (`globalThis.fetch`, `window['fetch']`,
 * `` self[`fetch`] ``, an alias of one, a computed key that is not a literal) and any destructuring of it out of one
 * (`const { fetch: get } = globalThis`). Text matching missed `return fetch`, the destructuring and the bracket form.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AstNode, parseFile, walk } from '../../../../../../scripts/gen/lib/check.ts';

const APP = join(import.meta.dir, '..', '..', '..', 'app');

/** Comments removed, so prose about `XMLHttpRequest` (this file's own, and the product's) is not mistaken for a use. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

/** The kinds of plain-HTTP use that are not `fetch` (a name or an address, found in the code with comments removed). */
const OTHER_PLAIN_HTTP: readonly (readonly [string, RegExp])[] = [
  ['an XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['a beacon', /\bsendBeacon\b/u],
  ['an EventSource', /\bEventSource\b/u],
  ['a socket the app built itself', /\bnew\s+WebSocket\b/u],
  ['a plain-http address', /['"`]http:\/\//u],
];

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self', 'global']);
const FETCH_REFERENCE = 'a reference to the global fetch';
const FETCH_ON_GLOBAL = 'a reach for fetch on a global object';
const FETCH_DESTRUCTURED = 'fetch taken out of a global object by destructuring';
const FETCH_COMPUTED = 'a computed reach into a global object (it may be fetch)';

const asNode = (value: unknown): AstNode | undefined =>
  value !== null && typeof value === 'object' && typeof (value as AstNode).type === 'string'
    ? (value as AstNode)
    : undefined;

/** A node with the casts and parentheses of its expression peeled off: `globalThis as unknown as X` is `globalThis`. */
function unwrapped(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (
    current !== undefined &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression')
  )
    current = asNode(current.expression);
  return current;
}

/** The string a property key spells when it is a literal (`'fetch'`, `` `fetch` ``), `undefined` when it is not static. */
function staticKey(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as readonly { readonly value?: { readonly cooked?: string } }[];
    if ((node.expressions as readonly unknown[]).length === 0) return quasis[0]?.value?.cooked;
  }
  return undefined;
}

/** Whether a name in a pattern or a declaration BINDS a value rather than reads one. */
function declares(node: AstNode, parent: AstNode, grand: AstNode | undefined): boolean {
  switch (parent.type) {
    case 'VariableDeclarator':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id === node || (Array.isArray(parent.params) && parent.params.includes(node));
    case 'ArrowFunctionExpression':
      return Array.isArray(parent.params) && parent.params.includes(node);
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'RestElement':
    case 'ArrayPattern':
      return true;
    case 'AssignmentPattern':
      return parent.left === node;
    case 'Property':
      return grand?.type === 'ObjectPattern' && parent.value === node;
    default:
      return false;
  }
}

/**
 * Where the global `fetch` is reached in a file, by label. Resolution, not matching: a name only counts where the tree
 * makes it the global (a reference, not a property key of an object literal or a member of something else), a global
 * object is found by name and through every alias of it, and a computed key that is not a literal is refused because it
 * can spell `fetch` at run time. A type position (`typeof fetch`) reaches nothing and is skipped.
 */
function fetchUses(file: string): readonly string[] {
  const { program } = parseFile(file);
  const found = new Set<string>();

  // Pass 1: the names that stand for a global object here (`const g = globalThis`, `globals = globalThis as X`).
  const aliases = new Set<string>(GLOBAL_OBJECTS);
  for (let changed = true; changed; ) {
    changed = false;
    walk(program, node => {
      const bound =
        node.type === 'VariableDeclarator'
          ? { name: asNode(node.id), value: unwrapped(asNode(node.init)) }
          : node.type === 'AssignmentPattern'
            ? { name: asNode(node.left), value: unwrapped(asNode(node.right)) }
            : undefined;
      if (bound?.name?.type !== 'Identifier' || bound.value?.type !== 'Identifier') return;
      if (aliases.has(bound.value.name as string) && !aliases.has(bound.name.name as string)) {
        aliases.add(bound.name.name as string);
        changed = true;
      }
    });
  }
  const isGlobalObject = (node: AstNode | undefined): boolean => {
    const peeled = unwrapped(node);
    return peeled?.type === 'Identifier' && aliases.has(peeled.name as string);
  };

  walk(program, (node, parents) => {
    // A type position names a type, not the value.
    if (
      parents.some(
        p =>
          p.type.startsWith('TS') &&
          p.type !== 'TSAsExpression' &&
          p.type !== 'TSNonNullExpression' &&
          p.type !== 'TSSatisfiesExpression',
      )
    )
      return;
    const parent = parents[parents.length - 1];
    const grand = parents[parents.length - 2];

    if (node.type === 'MemberExpression' && isGlobalObject(asNode(node.object))) {
      if (node.computed !== true) {
        if (asNode(node.property)?.name === 'fetch') found.add(FETCH_ON_GLOBAL);
      } else {
        const key = staticKey(asNode(node.property));
        if (key === 'fetch') found.add(FETCH_ON_GLOBAL);
        else if (key === undefined) found.add(FETCH_COMPUTED);
      }
      return;
    }

    if (node.type === 'ObjectPattern') {
      // `const { fetch: get } = globalThis` / `({ fetch } = window)`: the pattern's source is a global object.
      const source =
        parent?.type === 'VariableDeclarator' && parent.id === node
          ? asNode(parent.init)
          : parent?.type === 'AssignmentExpression' && parent.left === node
            ? asNode(parent.right)
            : undefined;
      if (!isGlobalObject(source)) return;
      for (const property of node.properties as readonly AstNode[]) {
        if (property.type === 'RestElement') {
          found.add(FETCH_COMPUTED);
          continue;
        }
        const key = property.computed === true ? staticKey(asNode(property.key)) : nameKey(asNode(property.key));
        if (key === 'fetch') found.add(FETCH_DESTRUCTURED);
        else if (key === undefined) found.add(FETCH_COMPUTED);
      }
      return;
    }

    if (node.type !== 'Identifier' || node.name !== 'fetch' || parent === undefined) return;
    // The property after a dot is judged with its object (above); an object-literal or class key is a name, not a use.
    if (parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true) return;
    if (
      (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
      parent.key === node &&
      parent.computed !== true &&
      !(parent.type === 'Property' && parent.shorthand === true && parent.value === node)
    )
      return;
    if (declares(node, parent, grand)) return;
    found.add(FETCH_REFERENCE);
  });
  return [...found];
}

/** The name an ordinary (non-computed) property key spells. */
function nameKey(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'Identifier') return node.name as string;
  return staticKey(node);
}

/** Which kinds of plain-HTTP use a source file contains, by label. */
function plainHttpUses(file: string): readonly string[] {
  const text = code(readFileSync(file, 'utf8'));
  return [...fetchUses(file), ...OTHER_PLAIN_HTTP.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)];
}

const appFiles = (): readonly string[] =>
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: APP })].sort().map(path => join(APP, path));

/** Writes one planted source to a temp file (the tree is parsed from a path) and answers what the scan finds in it. */
function usesIn(source: string): readonly string[] {
  const folder = mkdtempSync(join(tmpdir(), 'fy-no-plain-http-'));
  try {
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'planted.tsx');
    writeFileSync(file, source);
    return plainHttpUses(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('no plain-HTTP device path (R223)', () => {
  test('R223 no file under app/ reaches the global fetch or opens a socket or request of its own', () => {
    const files = appFiles();
    // The scan reads the real tree: an empty glob would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(15);
    const found = files.flatMap(file => plainHttpUses(file).map(use => `${file}: ${use}`));
    expect(found).toEqual([]);
  });

  test('R223 cb4 F1 the scan finds the global fetch in every form it can be reached, by resolving it in the tree', () => {
    const planted: readonly (readonly [string, string, string])[] = [
      ['a call', 'const answer = await fetch(url);', FETCH_REFERENCE],
      ['returned as a value', 'export const grab = () => { return fetch; };', FETCH_REFERENCE],
      ['kept in a field', 'class Holder { network = fetch; }', FETCH_REFERENCE],
      ['passed along', 'run(fetch);', FETCH_REFERENCE],
      ['a default', 'const use = (network = fetch) => network;', FETCH_REFERENCE],
      ['an object property value', 'const ports = { network: fetch };', FETCH_REFERENCE],
      ['an object shorthand', 'const ports = { fetch };', FETCH_REFERENCE],
      ['on globalThis', 'const get = globalThis.fetch;', FETCH_ON_GLOBAL],
      ['on window', 'window.fetch(url);', FETCH_ON_GLOBAL],
      ['on self, optionally', 'self?.fetch?.(url);', FETCH_ON_GLOBAL],
      ['by a bracket and a string', "const get = globalThis['fetch'];", FETCH_ON_GLOBAL],
      ['by a bracket and a template', 'const get = window[`fetch`];', FETCH_ON_GLOBAL],
      ['through a cast', "const get = (globalThis as { fetch: () => void })['fetch'];", FETCH_ON_GLOBAL],
      ['through an alias', 'const root = globalThis; const get = root.fetch;', FETCH_ON_GLOBAL],
      [
        'through a defaulted parameter',
        'const dial = (globals = globalThis as X) => globals.fetch(url);',
        FETCH_ON_GLOBAL,
      ],
      ['destructured, renamed', 'const { fetch: get } = globalThis;', FETCH_DESTRUCTURED],
      ['destructured, shorthand', 'const { fetch } = window;', FETCH_DESTRUCTURED],
      ['destructured by assignment', 'let get; ({ fetch: get } = self);', FETCH_DESTRUCTURED],
      ['destructured, a string key', "const { ['fetch']: get } = globalThis;", FETCH_DESTRUCTURED],
      ['a computed name', 'const get = globalThis[name];', FETCH_COMPUTED],
      ['a rest of the global', 'const { ...everything } = globalThis;', FETCH_COMPUTED],
    ];
    for (const [name, source, label] of planted)
      expect({ name, uses: usesIn(source) }).toEqual({ name, uses: [label] });
  });

  test('R223 the scan finds each other kind of plain-HTTP use it is named for, and ignores comments about them', () => {
    const planted: Readonly<Record<string, string>> = {
      'an XMLHttpRequest': 'const request = new XMLHttpRequest();',
      'a beacon': 'navigator.sendBeacon(url, body);',
      'an EventSource': 'const stream = new EventSource(url);',
      'a socket the app built itself': 'const socket = new WebSocket(url);',
      'a plain-http address': "const base = 'http://box.example';",
    };
    for (const [label, source] of Object.entries(planted)) expect(usesIn(source)).toContain(label);
    expect(usesIn('// we never call fetch( here\n/* nor new WebSocket(x) */ const ok = 1;')).toEqual([]);
  });

  test('R223 cb4 F1 the scan leaves alone what is not the global fetch: injected fetchers, other objects, keys, types and other globals', () => {
    const innocent: readonly (readonly [string, string])[] = [
      ['an injected fetcher', 'const body = await ports.directory(url);'],
      ['a member called fetch on another object', 'const body = await ports.fetch(url);'],
      ['a key of an object literal', 'const ports = { fetch: injected };'],
      ['a class member', 'class Directory { fetch(url) { return url; } }'],
      ['a type', 'type Network = typeof fetch; const slice: Pick<typeof globalThis, "fetch"> = injected;'],
      ['an unrelated global', 'const stored = (globalThis as { localStorage?: Storage }).localStorage;'],
      ['a timer on the global', 'globalThis.setTimeout(action, 10);'],
      ['a destructured name that is not fetch', 'const { navigator } = globalThis;'],
      ['fetch destructured from an injected object', 'const { fetch: get } = ports;'],
      ['an alias of something that is not a global', 'const slice = ports; slice.fetch(url);'],
    ];
    for (const [name, source] of innocent) expect({ name, uses: usesIn(source) }).toEqual({ name, uses: [] });
  });

  test('R223 the shell’s own seams are what the app half does reach: sockets and the directory read are injected', () => {
    const index = readFileSync(join(APP, 'index.ts'), 'utf8');
    expect(index).toContain('openSocket: ports.openSocket');
    expect(index).toContain('ctx.client');
    expect(readFileSync(join(APP, 'lib', 'tunnel-service.ts'), 'utf8')).toContain('fetcher');
  });
});
