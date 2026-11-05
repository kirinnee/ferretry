import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEED_TEST_PATH } from '../../src/lib/stt/speed-plan.ts';
import viteConfig from '../../vite.config.ts';

const packageDir = join(import.meta.dir, '../..');
const page = readFileSync(join(packageDir, 'speed-bench/index.html'), 'utf8');

describe('the /speed-bench/ page the Settings link opens', () => {
  it('is a built entry of the production bundle, at the address the link names', () => {
    const input = viteConfig.build?.rollupOptions?.input as Record<string, string>;
    expect(input['speed-bench']).toBe(join(packageDir, 'speed-bench/index.html'));
    expect(SPEED_TEST_PATH).toBe('/speed-bench/');
    expect(existsSync(join(packageDir, `.${SPEED_TEST_PATH}index.html`))).toBe(true);
  });

  it('is self-contained under the page policy: one same-origin module script, no inline script, no address, no form', () => {
    const scripts = [...page.matchAll(/<script\b[^>]*>/gu)].map(match => match[0]);
    expect(scripts).toEqual(['<script type="module" src="./main.ts">']);
    expect(page).not.toMatch(/https?:\/\//u);
    expect(page).not.toMatch(/<form\b|<iframe\b|<img\b|<link\b/u);
  });

  it('keeps its dark colours after the light ones, so the result boxes are readable in dark mode', () => {
    expect(page.indexOf('@media (prefers-color-scheme: dark)')).toBeGreaterThan(page.indexOf('background: #f3f3f3'));
  });
});
