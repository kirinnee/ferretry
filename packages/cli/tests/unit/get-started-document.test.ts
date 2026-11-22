import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '../../src/generated/commands.ts';
import { buildVerbTable } from '../../src/lib/verbs.ts';

/** Onboarding's static page, read as a file: the CLI owns the verbs this test checks the page against. */
const pluginDir = join(import.meta.dir, '../../../plugins/onboarding');
const page = readFileSync(join(pluginDir, 'app/get-started/index.html'), 'utf8');

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

const verbs = buildVerbTable(registry).entries.map(entry => entry.line);
const isRegistered = (command: string): boolean =>
  !command.startsWith('fy ') || verbs.some(verb => command === `fy ${verb}` || command.startsWith(`fy ${verb} `));

const METHODS = ['brew', 'nix', 'home-manager', 'installer'] as const;

describe('the static /get-started document', () => {
  it('is a static page like the landing, built as its own entry', () => {
    expect(page).not.toContain('/src/main.tsx');
    expect(page).not.toContain('type="module"');
    expect(page).not.toContain('rel="manifest"');
  });

  it('leads with install-then-setup, then pairing and the app', () => {
    const order = ['Install it, then run setup.', 'Pair your phone.', 'Finish setup in the app.'];
    const positions = order.map(text => page.indexOf(text));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const topic of ['Claude Code', 'Codex', 'Keys', 'Voice', 'Warden']) expect(page).toContain(topic);
    expect(page).toContain('encrypted relay');
    expect(page).not.toContain('fy daemon install');
  });

  it('gives every install method a tab whose commands end with fy onboard', () => {
    for (const method of METHODS) {
      const panel = page.match(
        new RegExp(`<div[^>]*role="tabpanel"[^>]*data-method="${method}"[^>]*>([\\s\\S]*?)\\n {14}</div>`),
      );
      expect(panel?.[1]).toBeDefined();
      const commands = [...(panel?.[1] ?? '').matchAll(/<code[^>]* data-command>([^<]*)<\/code>/g)].map(match =>
        decode(match[1] ?? ''),
      );
      expect(commands.at(-1)).toMatch(/fy onboard$/);
    }
  });

  it('shows the troubleshooting commands and the build-time release version', () => {
    for (const command of ['fy onboard --check', 'fy daemon status', 'fy doctor', 'fy onboard reset']) {
      expect(pageCommands).toContain(command);
    }
    expect(pageCommands).toContain('xattr -d com.apple.quarantine "$(command -v fy)"');
    expect(page).toContain('v%FY_RELEASE_VERSION%');
  });

  it('shows only registered fy commands', () => {
    expect(pageCommands.length).toBeGreaterThan(10);
    expect(pageCommands.filter(command => !isRegistered(command))).toEqual([]);
  });

  it('keeps the existing app as the secondary step for a device that is already paired', () => {
    expect(page).toContain('href="/app"');
    expect(page).not.toContain('location.replace');
  });
});

describe('the "let your agent do it" path (removed, C59 O7)', () => {
  it('has no agent section, prompt, copy-prompt button or link to one', () => {
    expect(page).not.toMatch(/let your agent do it|have your agent do it|copy the prompt/i);
    expect(page).not.toContain('data-agent-prompt');
    expect(page).not.toContain('id="agent"');
    expect(page).not.toContain('href="#agent"');
    expect(page).not.toMatch(/class="[^"]*\bprompt\b[^"]*"/);
  });
});
