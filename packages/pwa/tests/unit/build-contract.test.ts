/**
 * The Vite config decides directory names that things OUTSIDE this package
 * independently hardcode, so a rename here is not a local change.
 *
 * The separately owned Cloudflare Pages deployment is still pending. Its
 * declared contract is to publish `packages/pwa/dist/` and apply immutable
 * caching only beneath `assets/`. Rename either directory here and that deploy
 * will be wrong when it lands. Neither failure is visible in a build log, so
 * this package pins the values it owns against the real config object.
 *
 * The config is IMPORTED, not text-matched: what matters is the value Vite
 * resolves, including that the PostCSS pipeline really has Tailwind in it. A
 * missing plugin does not fail a build — it emits `@tailwind base;` as literal
 * text and ships an unstyled app.
 */

import { describe, expect, it } from 'bun:test';
import viteConfig from '../../vite.config.ts';

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
    // Routes are `/d/<daemonId>/…`, so an app-rooted base keeps chunks away from
    // inside a daemon-scoped path.
    expect(viteConfig.base).toBe('/app/');
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
});
