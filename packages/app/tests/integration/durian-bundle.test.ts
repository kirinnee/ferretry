/**
 * r12 H1 — THE DURIAN DEPENDENCY AND ITS BUILD SEAM (the assertions that must be red on a base with no seam).
 *
 * `durian-hypermedia` is a git dependency pinned to a tag AND its commit. Its `dist/` is built by a `prepare`
 * script, and Ferretry installs with `--ignore-scripts` (nix/ferretry.nix), so the package arrives as source and the
 * bundle must read that source (the `bun` export condition) and build the stylesheet itself. This file proves, on the
 * real installed package and a real Vite build:
 *   1. the install is exactly v0.5.1 at its pinned commit, and `prepare` did not run (no `dist/`);
 *   2. one build holds ONE chart.js and ONE dompurify (Durian pins versions of its own);
 *   3. a chunk holds Durian's `VERSION` 0.5.1;
 *   4. the 3D chunk (three.js) is NOT in the static graph of a page without a 3D block: it is a lazy chunk;
 *   5. neither mermaid nor Durian's in-page DOMPurify drawing is in the bundle (the strict entry);
 *   6. the stylesheet is built, scoped under `.dh-doc`.
 * The plugin under test is the one the app's REAL `vite.config.ts` registers (found there by name), so the seam that
 * ships is the seam that is proved.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin, Rollup } from 'vite';
import { build } from 'vite';
import viteConfig from '../../vite.config.ts';

const WORKSPACE = join(import.meta.dir, '../../../..');
const CONVERSATION = join(WORKSPACE, 'packages/plugins/conversation');
const ENTRY = join(CONVERSATION, 'tests/fixtures/hypermedia-bundle-entry.ts');

/** What the owner approved: durian-hypermedia v0.5.1 (signed tag object 6e8bb8e013cc2e797ae8a3655f02677d5a0135ea), MIT. */
const PINNED_COMMIT = '951c81c7d537249073724c83a2266166e12f593b';
/** The SHA-512 of the tarball of that commit, as Bun recorded it: the bytes, not only the name. */
const PINNED_INTEGRITY =
  'sha512-+wJItdN5Wig3thHqFaZiTfKiLGzcb2q+hq4hKu2ZP/y1zG3udxPUpiYgUF0Hq9q9RX5IXzHYQ/hMh7MihsOyaw==';

/** The versions THIS app pins: the only ones the bundle may hold. */
const ours = (
  JSON.parse(readFileSync(join(CONVERSATION, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
).dependencies;

/** The Durian build plugin, taken from the shell's own config: registered there, or this file fails. */
const durianPlugin = (viteConfig.plugins as readonly { name?: string }[]).find(
  p => p.name === 'fy-durian-hypermedia',
) as Plugin;

const installed = dirname(createRequire(join(CONVERSATION, 'package.json')).resolve('durian-hypermedia/package.json'));

describe('the pinned install', () => {
  it('is v0.5.1, MIT, and records its commit in the lockfile', () => {
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
      version: string;
      license: string;
    };
    expect(manifest.version).toBe('0.5.1');
    expect(manifest.license).toBe('MIT');
    const lock = readFileSync(join(WORKSPACE, 'bun.lock'), 'utf8');
    const line = lock.split('\n').find(l => l.includes('"durian-hypermedia@'));
    expect(line).toBeDefined();
    // Bun records a git dependency's resolved commit (short or full) in the lock entry: a moved tag cannot move it.
    expect(line).toContain(`#${PINNED_COMMIT.slice(0, 7)}`);
    expect(line).toContain(PINNED_INTEGRITY);
  });

  it('names the full commit in the manifest, never a moving tag or range', () => {
    const own = JSON.parse(readFileSync(join(CONVERSATION, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(own.dependencies['durian-hypermedia']).toBe(`github:ProtoDurian/durian-hypermedia#${PINNED_COMMIT}`);
  });

  it('did not run `prepare`: no dist/ (installs use --ignore-scripts), and the package is never trusted to', () => {
    expect(existsSync(join(installed, 'dist'))).toBe(false);
    const root = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8')) as {
      trustedDependencies?: string[];
    };
    expect(root.trustedDependencies ?? []).not.toContain('durian-hypermedia');
  });
});

describe('one Vite build of the renderer entry', () => {
  let chunks: Rollup.OutputChunk[] = [];
  let assets: Rollup.OutputAsset[] = [];

  beforeAll(async () => {
    const result = (await build({
      configFile: false,
      root: CONVERSATION,
      logLevel: 'silent',
      mode: 'production',
      plugins: [durianPlugin],
      build: {
        write: false,
        // Unminified so the library banners and identifiers the assertions read survive.
        minify: false,
        target: 'es2022',
        rollupOptions: { input: ENTRY },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
    chunks = outputs.filter((o): o is Rollup.OutputChunk => o.type === 'chunk');
    assets = outputs.filter((o): o is Rollup.OutputAsset => o.type === 'asset');
  }, 240_000);

  const count = (pattern: RegExp): number => chunks.filter(c => pattern.test(c.code)).length;

  it('holds exactly one chart.js (ours) although Durian installs its own 4.5.1', () => {
    // Durian pins chart.js 4.5.1 and bun installs that copy beside it…
    const own = JSON.parse(readFileSync(join(dirname(installed), 'chart.js/package.json'), 'utf8')) as {
      version: string;
    };
    expect(own.version).toBe('4.5.1');
    // …and the bundle never reads it: every chart.js banner is ours, all in ONE (lazy) chunk.
    const banners = chunks.flatMap(c => [...c.code.matchAll(/Chart\.js v(\d+\.\d+\.\d+)/gu)].map(m => m[1]));
    expect([...new Set(banners)]).toEqual([ours['chart.js']]);
    expect(count(/Chart\.js v/u)).toBe(1);
  });

  it('holds exactly one dompurify, ours, not Durian’s 3.4.18', () => {
    const purifiers = chunks.flatMap(c => [...c.code.matchAll(/DOMPurify (\d+\.\d+\.\d+)/gu)].map(m => m[1]));
    expect(purifiers).toEqual([ours.dompurify]);
  });

  it('holds the chunk with Durian VERSION 0.5.1', () => {
    // `VERSION` is a constant the bundler inlines, so the chunk is the one holding the version AND Durian's parser.
    expect(count(/"0\.5\.1"[\s\S]*registeredBlocks|registeredBlocks[\s\S]*"0\.5\.1"/u)).toBe(1);
  });

  it('keeps three.js out of the static graph: the 3D chunk is lazy', () => {
    const entry = chunks.find(c => c.isEntry);
    expect(entry).toBeDefined();
    // Everything the entry loads WITHOUT a dynamic import(): the chunks a page without a 3D block downloads.
    const staticClosure = new Set<string>();
    const visit = (name: string): void => {
      if (staticClosure.has(name)) return;
      staticClosure.add(name);
      const chunk = chunks.find(c => c.fileName === name);
      for (const imported of chunk?.imports ?? []) visit(imported);
    };
    visit(entry!.fileName);
    const threeChunks = chunks.filter(c => /WebGLRenderer/u.test(c.code));
    expect(threeChunks.length).toBe(1);
    expect(staticClosure.has(threeChunks[0]!.fileName)).toBe(false);
    // …and something loads it on demand.
    expect(chunks.some(c => c.dynamicImports.includes(threeChunks[0]!.fileName))).toBe(true);
  });

  it('holds no mermaid and no in-page DOMPurify drawing', () => {
    expect(count(/mermaidAPI|mermaid\.initialize|import\("mermaid"\)/u)).toBe(0);
    expect(count(/dh-mmd-/u)).toBe(0);
  });

  it('builds the stylesheet from source, scoped under .dh-doc', () => {
    const css = assets.filter(a => a.fileName.endsWith('.css')).map(a => String(a.source));
    expect(css.length).toBe(1);
    expect(css[0]).toContain('.dh-doc');
    expect(css[0]).not.toMatch(/^\s*(?:html|body|:root)\s*[,{]/mu);
  });
});
