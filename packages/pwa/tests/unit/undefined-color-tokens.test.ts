import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../tailwind.config.ts';

const ROOT = join(import.meta.dir, '../..');
const SOURCES = ['src', 'harness'];

const COLOR_FAMILIES = 'surface|fg|accent|ok|warn|pend|err|syn|user|scrim|nav|appnav|tab|step|ground|selection';
const COLOR_UTILITY = new RegExp(
  `(?<![\\w-])(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|caret)-((?:${COLOR_FAMILIES})(?:-[a-z0-9]+)*)(?:/[0-9.]+)?(?![\\w-])`,
  'gu',
);

const files = (directory: string): readonly string[] =>
  readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(?:ts|tsx)$/u.test(entry) ? [path] : [];
  });

const colorKeys = (): ReadonlySet<string> => new Set(Object.keys(config.theme?.extend?.colors ?? {}));

const undefinedTokens = (source: string, known: ReadonlySet<string>): readonly string[] =>
  [...source.matchAll(COLOR_UTILITY)].map(match => match[1] ?? '').filter(token => !known.has(token));

describe('Tailwind colour utilities', () => {
  it('should only name colour tokens the Tailwind config defines, because an undefined one renders transparent', () => {
    // Arrange
    const known = colorKeys();

    // Act
    const offenders = SOURCES.flatMap(source =>
      files(join(ROOT, source)).flatMap(file =>
        undefinedTokens(readFileSync(file, 'utf8'), known).map(token => `${file.slice(ROOT.length + 1)}: ${token}`),
      ),
    );

    // Assert
    expect(offenders).toEqual([]);
  });

  it('should recognise an undefined token, an opacity-suffixed token and an unrelated utility', () => {
    // Arrange
    const known = new Set(['surface', 'surface-2']);

    // Act
    const found = undefinedTokens('bg-surface-1 bg-surface-2/50 text-ui border-surface hover:bg-surface-9', known);

    // Assert
    expect(found).toEqual(['surface-1', 'surface-9']);
  });
});
