import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEED_TEST_PATH } from '../../src/lib/stt/speed-plan.ts';
import viteConfig from '../../vite.config.ts';

const packageDir = join(import.meta.dir, '../..');
const page = readFileSync(join(packageDir, 'speed-bench/index.html'), 'utf8');
const mainSource = readFileSync(join(packageDir, 'speed-bench/main.ts'), 'utf8');

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

  it('hides the two result boxes until a run fills them, so they never read as broken empty boxes', () => {
    expect(page).toMatch(/pre:empty\s*\{\s*display:\s*none;/u);
    expect(page).toMatch(/<pre id="log"[^>]*><\/pre>/u);
    expect(page).toMatch(/<pre id="result"[^>]*><\/pre>/u);
  });

  it('starts with the download box UNTICKED and names exactly what ticking it does', () => {
    const install = page.match(/<input[^>]*id="install"[^>]*>/u)?.[0] ?? '';
    expect(install).not.toBe('');
    expect(install).not.toContain('checked');
    expect(page).toContain('Download the speech models first (from huggingface.co, about');
    // The page passes the box's state, nothing else, as the install switch.
    expect(mainSource).toContain("install: element<HTMLInputElement>('install').checked");
  });

  it('has a way back to Settings, a plain-language summary above the JSON, and a non-breaking "5 s"', () => {
    expect(page).toContain('id="back" href="/app/">Back to Settings</a>');
    expect(page.indexOf('id="summary"')).toBeLessThan(page.indexOf('id="result"'));
    expect(page).toContain('(5&nbsp;s)');
    expect(page).not.toContain('(5 s)');
  });

  it('keeps every checkbox row at least 44 px tall (the label is the tap target) and a visible disabled button in dark', () => {
    expect(page).toMatch(/label \{[^}]*min-height: 44px/u);
    const dark = page.slice(page.indexOf('@media (prefers-color-scheme: dark)'));
    expect(dark).toMatch(/button:disabled \{[^}]*color: #c4c4c4/u);
  });
});
