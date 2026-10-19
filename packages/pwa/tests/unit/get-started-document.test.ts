import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../support/dom.ts';

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
    expect(viteConfig).toContain("html.replaceAll('%FY_RELEASE_VERSION%', appVersion)");
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

describe('the "Let your agent set it up" prompt', () => {
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1] ?? '';
  const markup = page
    .slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
    .replace(/<script>[\s\S]*?<\/script>/, '');
  let copied: string[] = [];

  /** Boot the page's own script against its own markup, the way a browser does. */
  const boot = (): void => {
    document.documentElement.className = '';
    document.body.innerHTML = markup;
    copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    new Function(script)();
  };
  const selectTab = (os: string): void => {
    (document.querySelector(`[role="tab"][data-os="${os}"]`) as HTMLElement).click();
  };
  const prompt = (): string => document.querySelector('[data-agent-prompt]')?.textContent ?? '';
  /** The lines the page shows in the install blocks the prompt is built from, for one tab. */
  const installLines = (os: string): string[] =>
    [...document.querySelectorAll(`[role="tabpanel"][data-os="${os}"] [data-agent-install] [data-command]`)].map(
      line => line.textContent ?? '',
    );
  const fencedInPrompt = (text: string): string[] => {
    const lines: string[] = [];
    let fenced = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('```')) fenced = !fenced;
      else if (fenced) lines.push(line);
    }
    return lines;
  };

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('ships hidden, so a visitor without the script never sees an empty prompt', () => {
    expect(markup).toMatch(/<section class="agent" id="agent"[^>]* hidden>/);
    expect(markup).toContain('Paste this into Claude Code or Codex, in a terminal on the machine you want to use.');
  });

  it('is assembled from the commands on the page for each tab, which INSTALLATION.md carries', () => {
    boot();
    for (const os of ['macos', 'linux', 'nix']) {
      selectTab(os);
      const text = prompt();
      const install = installLines(os);
      expect(install.length).toBeGreaterThan(0);
      for (const line of install) expect(text).toContain(line);
      // Every line the prompt puts in a code fence is a line INSTALLATION.md carries, exactly as written.
      expect(fencedInPrompt(text)).toEqual(install);
      expect(fencedInPrompt(text).filter(line => !fencedLines.has(line))).toEqual([]);
      for (const key of ['daemon-install', 'daemon-status', 'daemon-logs', 'pair', 'pair-open', 'pair-print']) {
        const command = document.querySelector(`[data-key="${key}"]`)?.textContent ?? '';
        expect(fencedLines.has(command)).toBe(true);
        expect(text).toContain(command);
      }
    }
  });

  it('follows the selected install method and no other', () => {
    boot();
    selectTab('macos');
    expect(prompt()).toContain('brew install --cask ferretry');
    expect(prompt()).not.toContain('apt install');
    expect(prompt()).not.toContain('nix profile');
    selectTab('linux');
    expect(prompt()).toContain('sudo apt install fy');
    expect(prompt()).toContain('sudo dnf install fy');
    expect(prompt()).not.toContain('brew');
    selectTab('nix');
    expect(prompt()).toContain('nix profile install github:kirinnee/ferretry');
    expect(prompt()).not.toContain('nix shell');
    expect(document.querySelector('.agent [data-agent-os]')?.textContent).toBe('Nix');
  });

  it('asks before sudo, keeps secrets out, checks the daemon, and stops for the human to scan', () => {
    boot();
    const text = prompt();
    expect(text).toContain('Ask me before you run anything that needs sudo.');
    expect(text).toContain('Never print, paste or save a secret, token or the pairing code');
    expect(text).toContain('Success: it says the daemon is serving.');
    expect(text).toContain('fy pair --open --no-wait');
    expect(text).toContain('fy pair --no-wait');
    expect(text).toContain('Stop here.');
    expect(text.indexOf('fy daemon install')).toBeLessThan(text.indexOf('fy daemon status'));
    expect(text.indexOf('fy daemon status')).toBeLessThan(text.indexOf('fy pair --open --no-wait'));
  });

  it('copies exactly the prompt that is on screen', async () => {
    boot();
    selectTab('nix');
    (document.querySelector('.agent .copy') as HTMLElement).click();
    await Promise.resolve();
    expect(copied).toEqual([prompt()]);
    expect(prompt()).toContain('nix profile install');
  });

  it('only references keyed commands that exist on the page', () => {
    const keys = [...script.matchAll(/key\('([a-z-]+)'\)/g)].map(match => match[1] ?? '');
    expect(keys.length).toBeGreaterThan(4);
    for (const key of new Set(keys)) expect(page).toContain(`data-key="${key}"`);
  });
});
