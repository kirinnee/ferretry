/**
 * `index.html` is a contract with the browser that nothing else in the repo
 * checks.
 *
 * It is not typechecked, not linted and not imported, so a wrong path in it is a
 * blank page discovered by a deploy rather than by a build. Worse, its most
 * important clause is a NEGATIVE one: the pending Cloudflare Pages deployment
 * (not yet in this repo; a separate unit owns it) is meant to send
 * `script-src 'self'` via a `public/_headers` that does not exist here yet,
 * which would make an inline `<script>` — the shape kteam's document used for
 * its theme bootstrap — not merely untidy but dead under that policy. This
 * file asserts the document is already built as if that policy were live
 * (no inline script, a classic same-origin bootstrap) as a positive invariant,
 * rather than trusted to whoever edits the document next.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = join(import.meta.dir, '../..');

/** Comments carry example markup and paths; none of it is what the browser sees. */
const document = readFileSync(join(packageDir, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

interface ScriptTag {
  readonly attributes: string;
  readonly body: string;
}

const scripts: readonly ScriptTag[] = [...document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(match => ({
  attributes: match[1] ?? '',
  body: match[2] ?? '',
}));

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];

describe('the host document', () => {
  it('gives the app the one mount point main.tsx demands', () => {
    expect(document).toInclude('<div id="root"></div>');
  });

  it('boots the entry module that exists on disk', () => {
    const modules = scripts.filter(script => attribute(script.attributes, 'type') === 'module');
    expect(modules).toHaveLength(1);
    const source = attribute(modules[0]?.attributes ?? '', 'src');
    expect(source).toBe('/src/main.tsx');
    expect(existsSync(join(packageDir, 'src/main.tsx'))).toBe(true);
  });

  it('carries no inline script, because the deployment sends script-src self', () => {
    for (const script of scripts) {
      expect(script.body.trim()).toBe('');
      expect(attribute(script.attributes, 'src')).toBeString();
    }
  });

  it('runs the pre-paint bootstrap as a classic, parser-blocking script', () => {
    const bootstrap = scripts.find(script => attribute(script.attributes, 'src') === '/pre-paint.js');
    expect(bootstrap).toBeDefined();
    // `type="module"`, `defer` and `async` all move it after first paint, which
    // is the exact flash of the wrong theme the file exists to prevent.
    expect(attribute(bootstrap?.attributes ?? '', 'type')).toBeUndefined();
    expect(bootstrap?.attributes).not.toInclude('defer');
    expect(bootstrap?.attributes).not.toInclude('async');
  });

  it('references only same-origin files the bundle actually contains', () => {
    // Vite rewrites `/src/…` specifiers and copies `public/…` verbatim, so every
    // root-absolute reference must resolve under one of those two roots. A link
    // to a file nobody generates — an icon, a manifest — 404s on every load.
    const references = [...document.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(match => match[1] ?? '');
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const candidates = [join(packageDir, reference.slice(1)), join(packageDir, 'public', reference.slice(1))];
      expect(candidates.some(existsSync)).toBe(true);
    }
  });
});
