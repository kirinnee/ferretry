import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-accent-side-bar.sh';
const LEDGER = 'scripts/validate/no-accent-side-bar-allowlist.txt';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A throwaway git repo holding the gate, a ledger, and the planted stylesheets; returns the gate's run. */
const run = (files: Record<string, string>, ledger = ''): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-side-bar-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
  copyFileSync(join(root, GATE), join(dir, GATE));
  writeFileSync(join(dir, LEDGER), ledger);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  return spawnSync('bash', [join(dir, GATE)], { cwd: dir, encoding: 'utf8' });
};

describe('the accent side-bar gate', () => {
  test('is clean on this repository', () => {
    const result = spawnSync('bash', [join(root, GATE)], { cwd: root, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  const BARS: Record<string, string> = {
    'an inset shadow bar': '.a[aria-current] {\n  box-shadow: inset 3px 0 0 var(--accent);\n}\n',
    'an inset bar on the trailing edge': '.a[aria-current] {\n  box-shadow: inset -3px 0 0 #123;\n}\n',
    'an accent left border': '.a[data-open] {\n  border-left: 3px solid var(--accent);\n}\n',
    'a tone inline-start border': '.a {\n  border-inline-start: 3px solid var(--tone);\n}\n',
    'an accent left border colour': '.a[data-lit] {\n  border-left-color: var(--accent);\n}\n',
    'an inset bar with no colour (draws currentColor)':
      '.a[aria-current] {\n  color: var(--accent);\n  box-shadow: inset 3px 0 0;\n}\n',
    'a colourless inset bar closed on one line':
      '.a[aria-current] { color: var(--accent); box-shadow: inset 3px 0 0; }\n',
    'a colourless inset bar with no semicolon': '.a[aria-current] { box-shadow: inset 3px 0 0 }\n',
    'a colourless inset bar with a px unit and !important': '.a { box-shadow: inset 3px 0px 0px!important; }\n',
    'a colourless inset bar first in a shadow list': '.a { box-shadow: inset 3px 0 0, 0 1px 2px #000; }\n',
    'a colourless inset bar at the end of the line': '.a {\n  box-shadow: inset 3px 0 0\n}\n',
    'a 3px accent strip': '.a::before {\n  width: 3px;\n  background: var(--accent);\n  content: "";\n}\n',
  };
  for (const [name, css] of Object.entries(BARS))
    test(`refuses ${name}`, () => {
      const result = run({ 'packages/x/a.css': css });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/x/a.css');
    });

  test('allows a neutral divider, a hard offset shadow and a round dot', () => {
    const result = run({
      'packages/x/a.css': [
        '.a {\n  border-left: 1px solid var(--border);\n}\n',
        '.b {\n  box-shadow: 3px 3px 0 var(--shadow-ink);\n}\n',
        '.c::before {\n  width: 8px;\n  background: var(--tone);\n  border-radius: 50%;\n}\n',
        '.d::before {\n  width: 3px;\n  background: var(--border);\n}\n',
      ].join(''),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('a ledgered file passes, and a ledgered file with no bar left fails', () => {
    const bar = '.a {\n  box-shadow: inset 2px 0 0 var(--accent);\n}\n';
    expect(run({ 'packages/x/hud.css': bar }, 'packages/x/hud.css  # pending\n').status).toBe(0);
    const stale = run({ 'packages/x/hud.css': '.a {\n  color: red;\n}\n' }, 'packages/x/hud.css  # pending\n');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('delete its line');
  });
});

describe('the accent side-bar gate, Tailwind classes in JSX (r11-2b K4)', () => {
  const TAILWIND_BARS: Record<string, string> = {
    'a warn left border': '<div className="flex gap-2 border-l-2 border-warn pl-3" />\n',
    'a start-side accent border': '<div className="border-s-4 border-accent" />\n',
    'a heavy accent-border left border': '<blockquote className="m-0 border-l-heavy border-accent-border pl-3" />\n',
    'an arbitrary-width left border': '<div className="border-l-[3px] border-err/40" />\n',
    'an arbitrary colour': '<div className="border-l-2 border-[var(--accent)]" />\n',
    'a variant-prefixed bar': '<div className="hover:border-l-4 hover:border-ok" />\n',
    'a colour that comes first': '<div className="border-warn border-l-2" />\n',
  };
  for (const [name, tsx] of Object.entries(TAILWIND_BARS))
    test(`refuses ${name}`, () => {
      const result = run({ 'packages/x/a.tsx': tsx });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/x/a.tsx');
    });

  test('allows a neutral divider, a 1px rule, an accent top border and a comment that names a bar', () => {
    const result = run({
      'packages/x/a.tsx': [
        '<blockquote className="border-l-2 border-border-strong pl-sm" />\n',
        '<div className="border-l border-border-soft" />\n',
        '<div className="border-t-2 border-warn" />\n',
        '<div className="border-2 border-accent" />\n',
        '// was border-l-2 border-warn\n',
        '{/* border-l-4 border-accent */}\n',
        ' * border-l-2 border-warn\n',
      ].join(''),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
