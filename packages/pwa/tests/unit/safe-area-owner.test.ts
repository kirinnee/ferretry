import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../../src');
const STYLES = 'styles/index.css';

const sourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.(css|tsx?)$/u.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );

const files = sourceFiles(SRC).map(path => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));
const styles = files.find(file => file.path === STYLES)?.text ?? '';
const rule = (selector: RegExp): string => styles.match(selector)?.[0] ?? '';

/** The bars a phone screen can end in: each is the bottom inset's owner while it is on screen. */
const OWNERS = [
  'lib/pages/session-chat-page.tsx',
  'shell/app-bar.tsx',
  'features/workspace/phone/terminal-key-bar.tsx',
  'features/fleet/setup/machine-onboarding.tsx',
];

describe('the bottom safe-area inset has one owner', () => {
  it('is read from the platform in exactly one place, the --inset-bottom definition', () => {
    const readers = files.filter(file => file.text.includes('safe-area-inset-bottom'));
    expect(readers.map(file => file.path)).toEqual([STYLES]);
    expect(styles.match(/safe-area-inset-bottom/gu)).toHaveLength(1);
    expect(styles).toContain('--inset-bottom: env(safe-area-inset-bottom, 0px);');
  });

  it('is paid whole — the home indicator zone is not halved or trimmed', () => {
    expect(styles).toContain('--safe-bottom: var(--inset-bottom);');
    expect(styles).not.toMatch(/--safe-bottom:\s*calc\(/u);
  });

  it('is zero while a software keyboard is up, because the home indicator is hidden', () => {
    expect(styles).toMatch(/html\[data-keyboard='open'\]\s*\{\s*--safe-bottom:\s*0px;\s*\}/u);
  });

  it('on a phone is paid by the bar the screen ends in, absorbing its own padding, and then not by the shell', () => {
    const phone = rule(/@media \(max-width: 767\.98px\) \{\s*\[data-safe-bottom\][\s\S]*?\n\}/u);
    expect(phone).toContain('padding-bottom: max(var(--own-pad-bottom, 0px), var(--safe-bottom));');
    expect(phone).toContain('.kt-shell:has([data-safe-bottom]:not([hidden] *)) {\n    padding-bottom: 0;');
    // Wider than a phone several columns meet the bottom edge: each pays for its own content so its surface
    // reaches the edge, and a bar keeps its own padding.
    expect(rule(/\.kt-shell \{[^}]*\}/u)).toContain('padding-bottom: var(--safe-bottom);');
    expect(styles).toMatch(/\n\[data-safe-bottom\] \{\s*padding-bottom: var\(--own-pad-bottom, 0px\);\s*\}/u);
  });

  it('wider than a phone lets every column run to the edge instead of the shell leaving a band under them', () => {
    const wide = rule(/@media \(min-width: 768px\) \{\s*\.kt-shell:has\(> \[data-sessions-bar\]\)[\s\S]*?\n\}/u);
    expect(wide).toContain('.kt-shell:has(> [data-sessions-bar]) {\n    padding-bottom: 0;');
    expect(wide).toContain('.fy-sbar--column,\n  .fy-sbar--rail {\n    padding-bottom: var(--safe-bottom);');
    expect(wide).toContain('[data-shell-main] {\n    padding-bottom: var(--safe-bottom);');
    expect(files.find(file => file.path === 'App.tsx')?.text).toContain('data-shell-main=""');
  });

  it('names its owners in markup, and no owner stacks a padding of its own on top', () => {
    for (const path of OWNERS) expect(files.find(file => file.path === path)?.text).toContain('data-safe-bottom=""');
    const composer = rule(/\.fy-chat-input \{\s*flex-shrink: 0;[^}]*\}/u);
    expect(composer).toContain('--own-pad-bottom: 0.5rem;');
    expect(composer).not.toContain('padding-bottom');
    const tabbar = rule(/\.kt-tabbar \{[^}]*\}/u);
    expect(tabbar).toContain('--own-pad-bottom: 0px;');
    expect(tabbar).not.toContain('margin-bottom');
    expect(tabbar).not.toContain('padding-bottom');
  });

  it('lets an installed iOS app claim the whole screen instead of starting a status bar short', () => {
    expect(styles).toMatch(
      /@media \(display-mode: standalone\) \{\s*html \{\s*min-height: min\(100lvh, calc\(100% \+ var\(--inset-top\)\)\);/u,
    );
  });
});
