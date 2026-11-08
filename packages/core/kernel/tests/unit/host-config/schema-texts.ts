/**
 * Hostile texts built from a REAL schema: every mapping and list the schema declares, down to a few levels, filled to
 * the size cap with values that are wrong for it — wrong-typed entries, entries with bad names, many objects of wrong
 * fields, the same value many times — and a YAML 1.1 tag on the first key. A test that took ANY value (`z.unknown()`)
 * could never find the slow paths that live in schema issues (one zod issue per entry, each located in the file), so
 * these are made from each declared file's own schema, read through its JSON Schema.
 *
 * Fake only: no text here holds a key shape.
 */
import { z } from 'zod';

type JsonSchema = Readonly<Record<string, unknown>>;

/** One step down a path: a mapping's key, or the first item of a list. */
type Part = string | 0;

/** Where a collection is, and which kind (`any`: the schema does not say, so both). */
interface CollectionSite {
  readonly path: readonly Part[];
  readonly kind: 'map' | 'list' | 'any';
}

const isObject = (value: unknown): value is JsonSchema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The JSON Schema a zod schema accepts as input; an unreadable one reads as "anything". */
function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input', cycles: 'ref' }) as JsonSchema;
  } catch {
    return {};
  }
}

/** Every mapping and list `root` declares, down to `maxDepth` steps, each once. */
function collectionSites(root: JsonSchema, maxDepth: number): readonly CollectionSite[] {
  const definitions = isObject(root.$defs) ? root.$defs : {};
  const found = new Map<string, CollectionSite>();
  const add = (site: CollectionSite): void => {
    const key = JSON.stringify(site.path);
    const before = found.get(key);
    found.set(key, before === undefined || before.kind === site.kind ? site : { path: site.path, kind: 'any' });
  };
  const walk = (raw: unknown, path: readonly Part[], depth: number, refs: ReadonlySet<string>): void => {
    if (!isObject(raw)) return;
    let node = raw;
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace('#/$defs/', '');
      // A recursive schema is walked once round its loop.
      if (refs.has(name)) return;
      refs = new Set([...refs, name]);
      node = isObject(definitions[name]) ? definitions[name] : {};
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch, path, depth, refs);
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const untyped = node.type === undefined && node.anyOf === undefined && node.oneOf === undefined;
    if (types.includes('object') || isObject(node.properties) || node.additionalProperties !== undefined) {
      add({ path, kind: 'map' });
      if (depth >= maxDepth) return;
      if (isObject(node.properties)) {
        for (const [key, sub] of Object.entries(node.properties)) walk(sub, [...path, key], depth + 1, refs);
      }
      if (isObject(node.additionalProperties)) walk(node.additionalProperties, [...path, 'k'], depth + 1, refs);
    } else if (types.includes('array') || node.items !== undefined) {
      add({ path, kind: 'list' });
      if (depth < maxDepth) walk(node.items, [...path, 0], depth + 1, refs);
    } else if (untyped && node.const === undefined && node.enum === undefined) {
      add({ path, kind: 'any' });
    }
  };
  walk(root, [], 0, new Set());
  return [...found.values()];
}

/** The lines that open `path` (block style), and the indentation its contents are written at. */
function opening(path: readonly Part[]): { readonly head: string; readonly indent: string } {
  let head = '';
  let indent = '';
  for (const part of path) {
    head += part === 0 ? `${indent}-\n` : `${indent}${JSON.stringify(part)}:\n`;
    indent += '  ';
  }
  return { head, indent };
}

/** `head`, then `line(index)` until `cap` bytes would be passed (every text here is ASCII). */
export function filled(cap: number, head: string, line: (index: number) => string): string {
  const parts = [head];
  let size = head.length;
  for (let index = 0; ; index += 1) {
    const next = line(index);
    if (size + next.length > cap) break;
    parts.push(next);
    size += next.length;
  }
  return parts.join('');
}

/** What a mapping or a list at a site is filled with: each wrong for nearly any schema, or many times the same. */
const MAP_BODIES: readonly (readonly [label: string, line: (index: number) => string])[] = [
  ['wrong-typed entries', index => `k${index.toString(36)}: []\n`],
  ['entries with bad names', index => `"k ${index.toString(36)}!": x\n`],
  ['entries of objects with wrong fields', index => `k${index.toString(36)}: {a: [], b: [], c: {}}\n`],
  ['the same value under many names', index => `k${index.toString(36)}: x\n`],
];
const LIST_BODIES: readonly (readonly [label: string, line: (index: number) => string])[] = [
  ['wrong-typed items', () => '- []\n'],
  ['objects with wrong fields', () => '- {a: [], b: [], c: {}}\n'],
  ['the same item many times', () => '- x\n'],
  ['distinct short items', index => `- ${index.toString(36)}\n`],
];

/**
 * Every hostile text for one schema, at `cap` bytes or just under: each collection site within `maxDepth` steps,
 * filled with each body its kind takes, and a `!!omap` and a `!!set` under the first key.
 */
export function schemaTexts(
  schema: z.ZodType,
  cap: number,
  maxDepth = 3,
): readonly (readonly [label: string, text: string])[] {
  const root = jsonSchemaOf(schema);
  const texts: (readonly [string, string])[] = [];
  for (const site of collectionSites(root, maxDepth)) {
    const { head, indent } = opening(site.path);
    const where = site.path.length === 0 ? 'the top' : site.path.join('.');
    const bodies = [...(site.kind === 'list' ? [] : MAP_BODIES), ...(site.kind === 'map' ? [] : LIST_BODIES)];
    for (const [label, line] of bodies) texts.push([`${where}: ${label}`, filled(cap, head, i => indent + line(i))]);
  }
  const first = isObject(root.properties) ? Object.keys(root.properties)[0] : undefined;
  const key = JSON.stringify(first ?? 'k');
  texts.push([
    `${key}: a flow !!omap of many keys`,
    `${filled(cap - 1, `${key}: !!omap [`, index => `${index.toString(36)}: ,`)}]`,
  ]);
  texts.push([
    `${key}: a block !!omap of many keys`,
    filled(cap, `${key}: !!omap\n`, i => `  - ${i.toString(36)}: 1\n`),
  ]);
  texts.push([`${key}: a !!set of many keys`, filled(cap, `${key}: !!set\n`, i => `  ? ${i.toString(36)}\n`)]);
  return texts;
}
