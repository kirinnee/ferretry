/**
 * The Vite config decides directory names that things OUTSIDE this package
 * independently hardcode, so a rename here is not a local change.
 *
 * `wrangler.jsonc` names the directory Cloudflare Pages publishes, and
 * `public/_headers` gives `/assets/*` an immutable year. Rename `outDir` and the
 * deploy publishes an empty directory; rename `assetsDir` and unfingerprinted
 * files inherit a one-year cache. Neither failure is visible in a build log, so
 * the contract is pinned against the real config object rather than described in
 * a comment.
 *
 * The config is IMPORTED, not text-matched: what matters is the value Vite
 * resolves, including that the PostCSS pipeline really has Tailwind in it. A
 * missing plugin does not fail a build — it emits `@tailwind base;` as literal
 * text and ships an unstyled app.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import viteConfig from '../../vite.config.ts';

const repoRoot = join(import.meta.dir, '../../../..');

describe('the bundler contract', () => {
  const build = viteConfig.build ?? {};

  it('writes the directory the Pages project publishes', () => {
    expect(build.outDir).toBe('dist');
    expect(build.emptyOutDir).toBe(true);
  });

  it('fingerprints assets into the directory the cache headers name', () => {
    expect(build.assetsDir).toBe('assets');
  });

  it('targets the baseline the ported source already requires, without sourcemaps', () => {
    expect(build.target).toBe('es2022');
    expect(build.sourcemap).toBe(false);
  });

  it('resolves assets from the site root, not from the current route', () => {
    // Routes are `/d/<daemonId>/…`, so a relative base would look for chunks
    // inside a daemon-scoped path.
    expect(viteConfig.base).toBe('/');
  });

  it('runs the design system through Tailwind and Autoprefixer', () => {
    const postcss = viteConfig.css?.postcss;
    const plugins = typeof postcss === 'object' && postcss !== null && 'plugins' in postcss ? postcss.plugins : [];
    const names = (plugins ?? []).map(plugin =>
      typeof plugin === 'object' && plugin !== null && 'postcssPlugin' in plugin ? plugin.postcssPlugin : undefined,
    );
    expect(names).toContain('tailwindcss');
    expect(names).toContain('autoprefixer');
  });

  it('refuses to move its dev port', () => {
    expect(viteConfig.server?.port).toBe(5173);
    expect(viteConfig.server?.strictPort).toBe(true);
  });

  it('agrees with the Pages output directory once that config is in the tree', () => {
    // The deployment lands on its own branch, so this activates when the two
    // meet rather than failing whichever arrives first. `wrangler.jsonc` is the
    // only place the deployed path is written; if it disagrees with `outDir`,
    // Pages publishes an empty directory.
    const wrangler = join(repoRoot, 'wrangler.jsonc');
    if (!existsSync(wrangler)) return;
    const declared = /"pages_build_output_dir"\s*:\s*"([^"]+)"/.exec(readFileSync(wrangler, 'utf8'))?.[1];
    expect(declared).toBe(`./packages/pwa/${build.outDir}`);
  });
});
