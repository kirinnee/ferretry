/**
 * A STYLE OR PALETTE IS KNOWN TO ITS OWN FOLDER AND NOWHERE ELSE. "Add a style" is a folder under `theme/packs/style/<id>/`,
 * and discovery, not registration, is only true while nothing else names that id. A shared stylesheet or component that
 * writes `[data-style='swiss']` re-creates the central list: dropping the pack leaves a dead rule behind, and a new style
 * has to be added in a second place. So outside `theme/packs/<kind>/<id>/`, no source file under `packages/*\/src` or a
 * plugin's `app` half may name `data-style='<id>'` or `data-palette='<id>'` for any discovered id. Tests and fixtures are exempt.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const repoRoot = join(import.meta.dir, '../../../..');
const packsRoot = join(repoRoot, 'packages/app/src/theme/packs');

type Kind = 'style' | 'palette';
const KINDS: readonly Kind[] = ['style', 'palette'];

const idsOf = (kind: Kind): string[] =>
  readdirSync(join(packsRoot, kind), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

const SOURCE_FILE = /\.(?:css|ts|tsx|js|jsx|html)$/u;
const SKIPPED_DIRS = new Set(['node_modules', 'tests', 'generated', 'dist', 'coverage']);

/** Every source file under the app's `src` and each package's `src` / plugin `app`, minus tests, fixtures and generated output. */
function sourceFiles(): string[] {
  const roots = [
    ...readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'plugins')
      .map(entry => join(repoRoot, 'packages', entry.name, 'src')),
    ...readdirSync(join(repoRoot, 'packages/plugins'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => [
        join(repoRoot, 'packages/plugins', entry.name, 'app'),
        join(repoRoot, 'packages/plugins', entry.name, 'src'),
      ]),
  ];
  const found: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(path);
      } else if (SOURCE_FILE.test(name)) found.push(path);
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

/** Prose that quotes a selector (a doc comment's example) is not a rule: block comments and whole-line `//` comments go. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

const posix = (path: string): string => path.split(sep).join('/');

/** The `<file>: data-style='<id>'` lines where a file outside the pack's own folder names the id. */
export function isolationViolations(
  files: ReadonlyMap<string, string>,
  ids: Readonly<Record<Kind, readonly string[]>>,
): string[] {
  const problems: string[] = [];
  for (const [path, raw] of files) {
    const text = withoutComments(raw);
    for (const kind of KINDS) {
      for (const id of ids[kind]) {
        if (path.startsWith(`packages/app/src/theme/packs/${kind}/${id}/`)) continue;
        const named = new RegExp(`data-${kind}\\s*=\\s*(?:\\\\?["'])?${id}(?![\\w-])`, 'u');
        if (named.test(text)) problems.push(`${path}: names ${kind} '${id}'`);
      }
    }
  }
  return problems;
}

describe('style and palette isolation', () => {
  it('refuses a rule that names a pack from outside the pack folder', () => {
    const ids = { style: ['swiss', 'mission'], palette: ['geist'] };
    const files = new Map([
      ['packages/app/src/ui/design-system.css', ":root[data-style='swiss'] .kt-input { outline: 0; }"],
      ['packages/app/src/shell/x.css', '[data-style="mission"] .a { }\n[data-palette=geist] .b { }'],
      ['packages/app/src/theme/packs/style/swiss/style.css', ":root[data-style='swiss'] .kt-input { outline: 0; }"],
      ['packages/app/src/theme/packs/style/mission/style.css', ":root[data-style='swiss'] .kt-input { outline: 0; }"],
      ['packages/app/src/ui/note.css', "/* e.g. [data-style='swiss'] */\n// data-palette='geist'"],
      ['packages/app/src/ui/ok.css', ":root[data-style='swiss-x'] .a { } :root[data-style] .b { }"],
    ]);
    expect(isolationViolations(files, ids)).toEqual([
      "packages/app/src/ui/design-system.css: names style 'swiss'",
      "packages/app/src/shell/x.css: names style 'mission'",
      "packages/app/src/shell/x.css: names palette 'geist'",
      "packages/app/src/theme/packs/style/mission/style.css: names style 'swiss'",
    ]);
  });

  it('finds the packs on disk, so the lint is not checking an empty list', () => {
    expect(idsOf('style').length).toBeGreaterThan(10);
    expect(idsOf('palette').length).toBeGreaterThan(8);
  });

  it('keeps every style and palette id inside its own pack folder', () => {
    const files = new Map(
      sourceFiles().map(path => [posix(relative(repoRoot, path)), readFileSync(path, 'utf8')] as const),
    );
    expect(files.size).toBeGreaterThan(500);
    expect(isolationViolations(files, { style: idsOf('style'), palette: idsOf('palette') })).toEqual([]);
  });
});
