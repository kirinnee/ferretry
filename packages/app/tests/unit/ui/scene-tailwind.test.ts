/**
 * A browser scene's stylesheet gets the utilities the app ships, whatever directory the scene builder runs in.
 *
 * The builder runs in the asking plugin's test folder. Handed the config object, Tailwind resolves the content globs
 * against the working directory, matched nothing there and emitted no utilities at all, so every scene page lacked
 * `.hidden` and `.sr-only`. `sceneTailwindConfig` anchors the globs to `packages/app`.
 */

import { describe, expect, it } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import type { Config } from 'tailwindcss';
import { anchoredTailwindConfig, sceneTailwindConfig } from '../../support/browser/scene-tailwind.ts';

const appRoot = resolve(import.meta.dir, '../../..');

const filesOf = (config: Config): readonly unknown[] =>
  Array.isArray(config.content) ? config.content : config.content.files;

describe('the scene Tailwind config', () => {
  it('anchors every relative glob to the config directory and leaves absolute globs and raw entries alone', () => {
    const raw = { raw: '<div class="flex">' };
    const config: Config = {
      content: { files: ['./src/**/*.tsx', '../plugins/*/app/**/*.tsx', '/abs/*.html', raw], relative: true },
    };
    expect(filesOf(anchoredTailwindConfig(config, '/repo/packages/app'))).toEqual([
      '/repo/packages/app/src/**/*.tsx',
      '/repo/packages/plugins/*/app/**/*.tsx',
      '/abs/*.html',
      raw,
    ]);
  });

  it('accepts the array form of content', () => {
    expect(filesOf(anchoredTailwindConfig({ content: ['./index.html'] }, '/root'))).toEqual(['/root/index.html']);
  });

  it('gives the app config only absolute globs, rooted at packages/app or its siblings', () => {
    for (const file of filesOf(sceneTailwindConfig)) {
      expect(typeof file).toBe('string');
      expect(isAbsolute(file as string)).toBe(true);
      expect((file as string).startsWith(resolve(appRoot, '..'))).toBe(true);
    }
  });

  // The unit runner's working directory is the repository root, not `packages/app` — where the unanchored config
  // emitted nothing.
  it('emits the shipped utilities from the anchored config', async () => {
    const css = (await postcss([tailwindcss(sceneTailwindConfig)]).process('@tailwind utilities;', { from: undefined }))
      .css;
    expect(css).toContain('.sr-only {');
    expect(css).toContain('.hidden {');
  }, 60_000);
});
