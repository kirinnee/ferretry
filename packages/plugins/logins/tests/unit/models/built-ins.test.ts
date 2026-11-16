import { afterEach, describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { checkedBuiltInModelCatalogs, checkedBuiltInPresets } from '../../../daemon/lib/built-ins.ts';
import { builtInsFresh, builtInsText, parsedBuiltIns } from '../../../scripts/built-ins.ts';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function written(text: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'logins-built-ins-'));
  folders.push(folder);
  const file = join(folder, 'built-ins.json');
  writeFileSync(file, text);
  return file;
}

describe('this build’s catalogs, parsed when built-ins.json is written', () => {
  it('should hold exactly what parsing the shipped files gives now (run scripts/built-ins.ts when this fails)', () => {
    // Act
    const parsed = parsedBuiltIns();

    // Assert — a catalog changed without regenerating, or a value JSON cannot carry, would differ here.
    should(builtInsFresh()).be.true();
    should(checkedBuiltInModelCatalogs()).eql(parsed.models);
    should(checkedBuiltInPresets()).eql(parsed.presets);
    should(Object.keys(parsed.models).length).be.above(0);
    should(parsed.presets.length).be.above(0);
  });

  it('should call a file stale when one value differs, it does not parse or it is missing', () => {
    // Arrange
    const parsed = parsedBuiltIns();
    const [first, ...rest] = parsed.presets;
    const changed = { ...parsed, presets: [{ ...first, label: `${String(first?.label)} (edited)` }, ...rest] };

    // Act / Assert
    should(builtInsFresh(written(builtInsText(parsed)))).be.true();
    should(builtInsFresh(written(builtInsText(changed as typeof parsed)))).be.false();
    should(builtInsFresh(written('{ "models": '))).be.false();
    should(builtInsFresh(join(tmpdir(), 'logins-built-ins-none', 'built-ins.json'))).be.false();
  });

  it('should compare values, not formatting', () => {
    // Arrange — the same values on one line, as a formatter might never write them.
    const file = written(`${JSON.stringify(parsedBuiltIns())}\n`);

    // Act / Assert
    should(builtInsFresh(file)).be.true();
  });
});
