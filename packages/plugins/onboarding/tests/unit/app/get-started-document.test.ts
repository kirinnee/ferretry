import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginDir = join(import.meta.dir, '../../..');
const page = readFileSync(join(pluginDir, 'app/get-started/index.html'), 'utf8');
const installation = readFileSync(join(pluginDir, '../../../INSTALLATION.md'), 'utf8');
/** The prompt's golden copy. Changing the prompt means changing this file too, in the same review. */
const goldenPrompt = readFileSync(join(pluginDir, 'tests/fixtures/agent-setup-prompt.txt'), 'utf8').replace(/\n$/, '');

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
  });

  it('shows only commands INSTALLATION.md carries, in a fenced block, exactly as written', () => {
    expect(pageCommands.length).toBeGreaterThan(10);
    expect(pageCommands.filter(command => !fencedLines.has(command))).toEqual([]);
  });

  it('keeps the existing app as the secondary step for a device that is already paired', () => {
    expect(page).toContain('href="/app"');
    expect(page).not.toContain('location.replace');
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
