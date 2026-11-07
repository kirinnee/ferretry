import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generated } from '../../../src/generated/surfaces.ts';

/**
 * The shell's client matches a route key by its exact string (`:ferretId` is not `:id`) and throws "no compiled
 * manifest declares" for one nobody owns. So a plugin's app half may only write route keys, and link to settings
 * tabs, that the compiled manifests declare. Proved here against the real compiled surfaces, for the app halves that
 * have been ported onto the shell client.
 */

const declaredRoutes = new Set(
  generated.surfaces.flatMap(entry => (entry.manifest.actions?.routes ?? []).map(route => route.key as string)),
);
const settingsTabs = new Set(
  generated.surfaces.flatMap(entry =>
    (entry.manifest.ui?.settings ?? []).map(tab => `${entry.id}/${tab.id as string}`),
  ),
);

const ROUTE_KEY = /['"`]((?:GET|POST|PUT|PATCH|DELETE) \/v1\/[^'"`\s]*)['"`]/gu;
const PLUGINS = join(import.meta.dir, '../../../../plugins');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/u.test(name)) yield path;
  }
}

describe('the routes a ported app half calls', () => {
  for (const plugin of ['runtimes']) {
    test(`${plugin}: every route key written in its app half is declared by a compiled manifest`, () => {
      const root = join(PLUGINS, plugin, 'app');
      const undeclared: string[] = [];
      let seen = 0;
      for (const file of sources(root))
        for (const match of readFileSync(file, 'utf8').matchAll(ROUTE_KEY)) {
          seen += 1;
          if (!declaredRoutes.has(match[1] as string)) undeclared.push(`${file.slice(root.length + 1)}: ${match[1]}`);
        }
      expect(seen).toBeGreaterThan(5);
      expect(undeclared).toEqual([]);
    });
  }

  test('the ferret detail read resolves against Ferrets’ declared parameter name', () => {
    expect(declaredRoutes.has('GET /v1/ferrets/:ferretId')).toBe(true);
    expect(declaredRoutes.has('GET /v1/ferrets/:id')).toBe(false);
  });
});

describe('the settings tabs a ported app half links to', () => {
  test('runtimes: its three tabs and Logins’ tab are declared, each by plugin and its own id', () => {
    for (const tab of ['runtimes/runtimes', 'runtimes/profiles', 'runtimes/model-sets', 'logins/logins'])
      expect(settingsTabs.has(tab)).toBe(true);
  });
});

describe('the screens a ported app half links to', () => {
  test('V-0285 runtimes: Import conversations links to /links, the path Conversation declares for its links screen', () => {
    const conversation = generated.surfaces.find(entry => entry.id === 'conversation');
    const screen = (conversation?.manifest.ui?.screens ?? []).find(candidate => candidate.id === 'links');
    expect(screen?.path).toBe('/links');
  });
});
