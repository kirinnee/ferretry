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
/** The prompt's golden copy. Changing the prompt means changing this file too, in the same review. */
const goldenPrompt = readFileSync(join(packageDir, 'tests/fixtures/agent-setup-prompt.txt'), 'utf8').replace(/\n$/, '');

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

/** The prompt exactly as the page ships it, before any script runs. */
const shippedPrompt = decode(page.match(/<code data-agent-prompt>([^<]*)<\/code>/)?.[1] ?? '');

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

const METHODS = ['brew', 'nix', 'home-manager', 'installer'] as const;

describe('the static /get-started document', () => {
  it('is a static page like the landing, built as its own entry', () => {
    expect(page).not.toContain('/src/main.tsx');
    expect(page).not.toContain('type="module"');
    expect(page).not.toContain('rel="manifest"');
    expect(viteConfig).toContain("'get-started': fileURLToPath(new URL('./get-started/index.html', import.meta.url))");
  });

  it('leads with install-then-setup, offers the agent second, then pairing and the app', () => {
    const order = [
      'Install it, then run setup.',
      'Or let your agent do it.',
      'Pair your phone.',
      'Finish setup in the app.',
    ];
    const positions = order.map(text => page.indexOf(text));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const topic of ['Claude Code', 'Codex', 'Keys', 'Voice', 'Warden']) expect(page).toContain(topic);
    expect(page).toContain('encrypted relay');
    expect(page).not.toContain('fy daemon install');
  });

  it('gives every install method a tab whose commands end with fy setup', () => {
    for (const method of METHODS) {
      const panel = page.match(
        new RegExp(`<div[^>]*role="tabpanel"[^>]*data-method="${method}"[^>]*>([\\s\\S]*?)\\n {14}</div>`),
      );
      expect(panel?.[1]).toBeDefined();
      const commands = [...(panel?.[1] ?? '').matchAll(/<code[^>]* data-command>([^<]*)<\/code>/g)].map(match =>
        decode(match[1] ?? ''),
      );
      expect(commands.at(-1)).toMatch(/fy setup$/);
    }
  });

  it('shows the troubleshooting commands and the build-time release version', () => {
    for (const command of ['fy setup --check', 'fy daemon status', 'fy daemon logs', 'fy daemon reset']) {
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

describe('the "Or let your agent do it" prompt', () => {
  const lines = shippedPrompt.split('\n');

  it('ships as the golden copy, visible with no script at all', () => {
    expect(shippedPrompt).toBe(goldenPrompt);
    expect(page).toMatch(/<section class="agent" id="agent" aria-labelledby="agent-title">/);
  });

  it('specifies the "Run this / Why / What you\'ll see" shape, in that order, and to stop after it', () => {
    const shape = ['**Run this**', '```bash', '```', '**Why:**', "**What you'll see:**"];
    let from = 0;
    for (const marker of shape) {
      const at = lines.findIndex((line, index) => index >= from && line.trim().startsWith(marker));
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
    expect(shippedPrompt).toContain('reply in exactly this shape, then stop and wait');
    expect(shippedPrompt).toContain('One action at a time. No paragraphs, no repeated caveats.');
    expect(shippedPrompt).toContain('3 to 5 short lines, then your recommendation');
  });

  it('leaves every install to the person, in the way each agent allows, and never loops', () => {
    expect(shippedPrompt).toContain('I run every install, update, sudo or service command myself.');
    expect(shippedPrompt).toContain('Claude Code: tell me to type the command after a ! in this chat.');
    expect(shippedPrompt).toContain('Codex: tell me to run it in my own terminal');
    expect(shippedPrompt).toContain('Never retry it or look for a way around it.');
    expect(shippedPrompt).toContain('Never print, save or ask for a token, a secret or a pairing code.');
    expect(shippedPrompt).toContain('fy pair as a "Run this" for my own terminal, not this chat');
  });

  it('detects read-only first, then recommends one method and lists the rest', () => {
    for (const probe of [
      'uname -sm',
      'command -v brew nix fy home-manager darwin-rebuild',
      'fy setup --check --json',
    ]) {
      expect(lines).toContain(`   ${probe}`);
    }
    expect(shippedPrompt).toContain(
      'recommend ONE way to install with a one-line reason, list the others one line each',
    );
    for (const method of ['Homebrew', 'Home Manager or nix-darwin', 'nix profile', 'Installer']) {
      expect(lines.some(line => line.startsWith(`   - ${method}`))).toBe(true);
    }
  });

  it('hands over only commands INSTALLATION.md carries, and every tab command but the interactive fy setup', () => {
    const handed = lines.filter(line => /^ {5}\S/.test(line)).map(line => line.trim());
    expect(handed.length).toBeGreaterThan(8);
    expect(handed.filter(command => !fencedLines.has(command))).toEqual([]);
    const tabCommands = pageCommands.filter(
      command => !/^fy (setup --check|daemon |pair)|^xattr/.test(command) && command !== 'fy setup',
    );
    for (const command of tabCommands) {
      expect(shippedPrompt).toContain(command.endsWith(' fy setup') ? `${command} --yes` : command);
    }
    expect(handed).toContain('fy setup --yes');
  });

  it('stays short enough to read before pasting', () => {
    expect(lines.length).toBeLessThanOrEqual(55);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(240);
  });

  it('names only fy commands this CLI has for afterwards, and the in-app update', () => {
    for (const command of [
      'fy daemon status',
      'fy credentials',
      'fy runtimes',
      'fy import conversations',
      'fy daemon setup',
    ]) {
      expect(shippedPrompt).toContain(command);
    }
    expect(shippedPrompt).toContain('fy daemon update, or the Update button in the app');
  });
});

describe('the page script', () => {
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1] ?? '';
  const markup = page
    .slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
    .replace(/<script>[\s\S]*?<\/script>/, '');
  let copied: string[] = [];

  /** Boot the page's own script against its own markup, the way a browser does. */
  const boot = (userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'): void => {
    document.documentElement.className = '';
    document.body.innerHTML = markup;
    copied = [];
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
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
  const visible = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      .filter(panel => !panel.hidden)
      .map(panel => panel.getAttribute('data-method') ?? '');

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('picks Homebrew on a Mac and the installer on Linux', () => {
    boot();
    expect(visible()).toEqual(['brew']);
    boot('Mozilla/5.0 (X11; Linux x86_64)');
    expect(visible()).toEqual(['installer']);
  });

  it('shows one method at a time, by click or arrow key', () => {
    boot();
    (document.querySelector('[role="tab"][data-method="home-manager"]') as HTMLElement).click();
    expect(visible()).toEqual(['home-manager']);
    const selected = document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
    selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(visible()).toEqual(['installer']);
    (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(visible()).toEqual(['brew']);
  });

  it('copies exactly the prompt, and a command block line by line', async () => {
    boot();
    (document.querySelector('.agent .copy') as HTMLElement).click();
    (document.querySelector('#panel-brew .copy') as HTMLElement).click();
    await Promise.resolve();
    expect(copied).toEqual([
      goldenPrompt,
      'brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry\nbrew install --cask ferretry\nfy setup',
    ]);
  });
});
