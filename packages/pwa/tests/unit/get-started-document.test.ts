import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = join(import.meta.dir, '../..');
const page = readFileSync(join(packageDir, 'get-started/index.html'), 'utf8');
const headers = readFileSync(join(packageDir, 'public/_headers'), 'utf8');
const installation = readFileSync(join(packageDir, '../../INSTALLATION.md'), 'utf8');
const viteConfig = readFileSync(join(packageDir, 'vite.config.ts'), 'utf8');

const decode = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

/** Every command line the page shows, as a reader would copy it. */
const pageCommands = [...page.matchAll(/<code[^>]* data-command>([^<]*)<\/code>/g)].map(match =>
  decode(match[1] ?? ''),
);

/** Every line inside a fenced block of INSTALLATION.md, with its list indentation dropped. */
const fencedLines = (() => {
  const lines: string[] = [];
  let fenced = false;
  for (const line of installation.split('\n')) {
    if (/^ *```/.test(line)) fenced = !fenced;
    else if (fenced) lines.push(line.replace(/^ +/, ''));
  }
  return new Set(lines);
})();

describe('the static /get-started document', () => {
  it('is a static page like the landing, built as its own entry', () => {
    expect(page).not.toContain('/src/main.tsx');
    expect(page).not.toContain('type="module"');
    expect(page).not.toContain('rel="manifest"');
    expect(viteConfig).toContain("'get-started': fileURLToPath(new URL('./get-started/index.html', import.meta.url))");
  });

  it('walks through install, daemon, pairing and in-app setup in order', () => {
    const order = ['Install it on your computer.', 'fy daemon install', 'fy pair', 'Finish setup in the app.'];
    const positions = order.map(text => page.indexOf(text));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const tab of ['macOS', 'Linux', 'Nix']) expect(page).toContain(`data-os="${tab.toLowerCase()}"`);
    for (const topic of ['Claude Code', 'Codex', 'Keys', 'Voice', 'Warden']) expect(page).toContain(topic);
    expect(page).toContain('encrypted relay');
  });

  it('shows the troubleshooting commands and the build-time release version', () => {
    for (const command of ['fy daemon status', 'fy daemon logs', 'fy daemon reset']) {
      expect(pageCommands).toContain(command);
    }
    expect(pageCommands).toContain('xattr -d com.apple.quarantine "$(command -v fy)"');
    expect(page).toContain('v%FY_RELEASE_VERSION%');
    expect(viteConfig).toContain("html.replaceAll('%FY_RELEASE_VERSION%', releaseVersion)");
  });

  it('shows only commands INSTALLATION.md carries, in a fenced block, exactly as written', () => {
    expect(pageCommands.length).toBeGreaterThan(10);
    expect(pageCommands.filter(command => !fencedLines.has(command))).toEqual([]);
  });

  it('keeps the existing app as the secondary step for a device that is already paired', () => {
    expect(page).toContain('href="/app"');
    expect(page).not.toContain('location.replace');
  });

  it('pins its one inline script in the site CSP', () => {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].flatMap(match =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(scripts).toHaveLength(1);
    for (const script of scripts) {
      const hash = createHash('sha256').update(script).digest('base64');
      expect(headers).toContain(`'sha256-${hash}'`);
    }
  });
});
