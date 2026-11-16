/**
 * The manifest's `actions` moved from one literal into `manifest/actions/*.actions.ts`, merged by the generator. This pins
 * that nothing about them changed: the fixture is the dump of the built `actions` taken from the commit before the move
 * (`tests/support/manifest-actions-dump.ts`), and every route, socket, tool and verb must match it field for field.
 *
 * Routes, sockets and tools match IN ORDER (a package's contract hash covers their order, so a reorder would show every
 * daemon "Update this daemon"). Verbs match as a set: they are listed per feature now, so `fy --help` groups a feature's
 * verbs together instead of following the old single list; no verb is resolved by its position.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionsDump } from '../support/manifest-actions-dump.ts';

interface Dump {
  readonly routes: readonly { readonly key: string }[];
  readonly sockets: readonly { readonly key: string }[];
  readonly agentTools: readonly { readonly name: string }[];
  readonly cli: readonly { readonly verb: string }[];
  readonly rest: Readonly<Record<string, unknown>>;
}

const parse = (text: string): Dump => JSON.parse(text) as Dump;
const base = (): Dump => parse(readFileSync(join(import.meta.dir, '../fixtures/manifest-actions.base.json'), 'utf8'));
const byVerb = (verbs: Dump['cli']): Dump['cli'] => [...verbs].sort((a, b) => (a.verb < b.verb ? -1 : 1));

/** The first difference between two dumps, or undefined when they say the same. */
function difference(expected: Dump, actual: Dump): string | undefined {
  for (const kind of ['routes', 'sockets', 'agentTools'] as const)
    if (JSON.stringify(expected[kind]) !== JSON.stringify(actual[kind])) return kind;
  if (JSON.stringify(byVerb(expected.cli)) !== JSON.stringify(byVerb(actual.cli))) return 'cli';
  if (JSON.stringify(expected.rest) !== JSON.stringify(actual.rest)) return 'rest';
  return undefined;
}

test('the built actions are the actions the single literal declared, descriptor for descriptor', () => {
  expect(difference(base(), parse(actionsDump()))).toBeUndefined();
});

test('the fixture is not empty, so the comparison has something to say', () => {
  const dump = base();
  expect(dump.routes.length).toBeGreaterThan(30);
  expect(dump.cli.length).toBeGreaterThan(40);
  expect(dump.sockets.length).toBe(1);
  expect(dump.agentTools.length).toBe(1);
});

test('the comparison fails when a route, a verb or a field goes missing', () => {
  const actual = parse(actionsDump());
  expect(difference(base(), { ...actual, routes: actual.routes.slice(1) })).toBe('routes');
  expect(difference(base(), { ...actual, routes: [...actual.routes].reverse() })).toBe('routes');
  expect(difference(base(), { ...actual, cli: actual.cli.slice(1) })).toBe('cli');
  const [first, ...rest] = actual.routes;
  expect(difference(base(), { ...actual, routes: [{ ...first, audit: 'changed' }, ...rest] as Dump['routes'] })).toBe(
    'routes',
  );
});

test('the generated list names every fragment file in the folder, and nothing else', () => {
  const root = join(import.meta.dir, '../..');
  const files = [...new Bun.Glob('*.actions.ts').scanSync({ cwd: join(root, 'manifest/actions') })].sort();
  const listed = [
    ...readFileSync(join(root, 'manifest/generated/actions.ts'), 'utf8').matchAll(/from '\.\.\/actions\/(.+)';/g),
  ].map(match => match[1]);
  expect(files.length).toBeGreaterThan(1);
  expect(listed).toEqual(files);
});
