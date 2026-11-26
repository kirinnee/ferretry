/**
 * THE `react/*` ENTRIES WE IMPORT, held to the installed release (U1 of the DurianMarkdown swap, 0.7.0). Our types for them are
 * hand-written (`app/hypermedia/types/durian-markdown-react.d.ts`), so a name we import that an entry does not export is a type error
 * nowhere and a blank part at runtime. Every value name each app source takes from each entry is checked against the entry's real
 * exports, and `react/strict` (which lists every part and defeats tree-shaking) is only ever imported for types.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dir, '../../../../app');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/u.test(entry.name) ? [join(dir, entry.name)] : [],
  );

interface Take {
  readonly file: string;
  readonly entry: string;
  readonly names: readonly string[];
}

const takes: Take[] = files(join(app, 'hypermedia')).flatMap(file => {
  const text = readFileSync(file, 'utf8');
  const out: Take[] = [];
  for (const match of text.matchAll(
    /^(?:import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+'(durian-markdown\/react\/[a-z]+)'/gmu,
  )) {
    if (match[1] !== undefined) continue;
    const names = (match[2] ?? '')
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== '' && !part.startsWith('type '))
      .map(part => part.split(/\s+as\s+/u)[0] as string);
    out.push({ file: file.slice(app.length + 1), entry: match[3] as string, names });
  }
  return out;
});

describe('every value an app source takes from a Durian react entry is exported by it', () => {
  it('finds the imports the unit expects', () => {
    expect(new Set(takes.map(take => take.entry))).toEqual(
      new Set(
        [
          'alignment',
          'codewalk',
          'containers',
          'editor',
          'filetree',
          'terminal',
          'tierlist',
          'document',
          'animation',
        ].map(name => `durian-markdown/react/${name}`),
      ),
    );
  });

  for (const take of takes)
    it(`${take.file} ← ${take.entry}: ${take.names.join(', ')}`, async () => {
      const exports = (await import(take.entry)) as Record<string, unknown>;
      expect(take.names.filter(name => !(name in exports))).toEqual([]);
    });

  it('react/strict is imported for types only (it lists every part: +550 KB first load)', () => {
    const value = files(join(app, 'hypermedia')).filter(file =>
      /^(?:import|export)\s+(?!type\b)[^;]*from\s+'durian-markdown\/react\/strict'/mu.test(readFileSync(file, 'utf8')),
    );
    expect(value).toEqual([]);
  });
});
