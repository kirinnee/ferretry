/**
 * R223 — THERE IS NO PLAIN-HTTP DEVICE PATH. Every call Connections' app half makes to a daemon rides the shell's
 * sealed session (`ctx.client`, or a socket the shell hands it); the only HTTP it ever performs is the public hosted
 * directory read, through the fetcher the shell INJECTS (`ports.directory`). So no file under `app/` may reach the
 * global `fetch`, an `XMLHttpRequest`, a beacon, an `EventSource` or a socket it built itself: a bare call there would
 * be a path to a daemon that no session seals and no device proves.
 *
 * A source scan, because the guarantee is about what the code CAN reach, not about what one run happened to call.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dir, '..', '..', '..', 'app');

/** Comments removed, so prose about `fetch` (this file's own, and the product's) is not mistaken for a call. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

const PLAIN_HTTP: readonly (readonly [string, RegExp])[] = [
  ['a call of the global fetch', /(^|[^.\w$])fetch\s*\(/u],
  ['the global fetch taken by value', /[=:?(,]\s*(globalThis\.|window\.|self\.)?fetch\b(?!\s*:)/u],
  ['a reach for fetch on a global', /\b(globalThis|window|self)\s*\.\s*fetch\b/u],
  ['an XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['a beacon', /\bsendBeacon\b/u],
  ['an EventSource', /\bEventSource\b/u],
  ['a socket the app built itself', /\bnew\s+WebSocket\b/u],
  ['a plain-http address', /['"`]http:\/\//u],
];

/** Which kinds of plain-HTTP use a source file contains, by label. */
function plainHttpUses(source: string): readonly string[] {
  const text = code(source);
  return PLAIN_HTTP.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

const appFiles = (): readonly string[] =>
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: APP })].sort().map(path => join(APP, path));

describe('no plain-HTTP device path (R223)', () => {
  test('R223 no file under app/ calls the global fetch or opens a socket or request of its own', () => {
    const files = appFiles();
    // The scan reads the real tree: an empty glob would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(15);
    const found = files.flatMap(file => plainHttpUses(readFileSync(file, 'utf8')).map(use => `${file}: ${use}`));
    expect(found).toEqual([]);
  });

  test('R223 the scan finds each kind of plain-HTTP use it is named for, and ignores comments about them', () => {
    const planted: Readonly<Record<string, string>> = {
      'a call of the global fetch': 'const answer = await fetch(url);',
      'the global fetch taken by value': 'const get = globalThis.fetch;',
      'an XMLHttpRequest': 'const request = new XMLHttpRequest();',
      'a beacon': 'navigator.sendBeacon(url, body);',
      'an EventSource': 'const stream = new EventSource(url);',
      'a socket the app built itself': 'const socket = new WebSocket(url);',
      'a plain-http address': "const base = 'http://box.example';",
    };
    for (const [label, source] of Object.entries(planted)) expect(plainHttpUses(source)).toContain(label);
    expect(plainHttpUses('// we never call fetch( here\n/* nor new WebSocket(x) */ const ok = 1;')).toEqual([]);
    // An injected fetcher is the sanctioned path: a member call is not a global one.
    expect(plainHttpUses('const body = await ports.directory(url);')).toEqual([]);
  });

  test('R223 the shell’s own seams are what the app half does reach: sockets and the directory read are injected', () => {
    const index = readFileSync(join(APP, 'index.ts'), 'utf8');
    expect(index).toContain('openSocket: ports.openSocket');
    expect(index).toContain('ctx.client');
    expect(readFileSync(join(APP, 'lib', 'tunnel-service.ts'), 'utf8')).toContain('fetcher');
  });
});
