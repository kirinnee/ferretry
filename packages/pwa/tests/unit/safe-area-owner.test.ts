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

describe('the bottom safe-area inset has one owner', () => {
  it('is read from the platform in exactly one place, the --safe-bottom definition', () => {
    const readers = files.filter(file => file.text.includes('safe-area-inset-bottom'));
    expect(readers.map(file => file.path)).toEqual([STYLES]);
    expect(readers[0]?.text).toContain('--safe-bottom: calc(env(safe-area-inset-bottom, 0px) / 2);');
  });

  it('is zero while a software keyboard is up, because the home indicator is hidden', () => {
    const styles = files.find(file => file.path === STYLES)?.text ?? '';
    expect(styles).toMatch(/html\[data-keyboard='open'\]\s*\{\s*--safe-bottom:\s*0px;\s*\}/u);
  });

  it('is paid by the shell and by nothing nested inside it', () => {
    const styles = files.find(file => file.path === STYLES)?.text ?? '';
    const shell = styles.match(/\.kt-shell \{[^}]*\}/u)?.[0] ?? '';
    expect(shell).toContain('padding-bottom: var(--safe-bottom);');
    const composer = styles.match(/\.fy-chat-input \{\s*flex-shrink: 0;[^}]*\}/u)?.[0] ?? '';
    expect(composer).toContain('padding-bottom: 0.5rem;');
    const tabbar = styles.match(/\.kt-tabbar \{[^}]*\}/u)?.[0] ?? '';
    expect(tabbar).toContain('margin-bottom: calc(-1 * var(--safe-bottom));');
    expect(tabbar).toContain('padding-bottom: var(--safe-bottom);');
  });
});
