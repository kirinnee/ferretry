/**
 * Writes `daemon/lib/built-ins.json`: what Logins' shipped model catalogs and endpoint presets parse to, so the daemon
 * imports the values as data and parses no YAML on boot (`daemon/lib/built-ins.ts` says why it is not a Bun macro).
 *
 *   bun run scripts/built-ins.ts           writes the file (then formats it with biome when biome is on PATH)
 *   bun run scripts/built-ins.ts --check   writes nothing; exits 1 when the file is not what the YAML parses to now
 *
 * The check compares parsed VALUES, never bytes, so a formatter's line breaks never make it stale.
 * Run it after changing anything under `daemon/data/models/` or `daemon/data/endpoints/`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clearYamlLogSwitches } from '@ferretry/std/yaml';
import type { BuiltIns } from '../daemon/lib/built-ins.ts';
import { builtInModelCatalogs } from '../daemon/lib/catalog/catalog.ts';
import { builtInPresets } from '../daemon/lib/presets/catalog.ts';

const BUILT_INS_FILE = resolve(import.meta.dir, '..', 'daemon', 'lib', 'built-ins.json');

/** What the shipped YAML parses to NOW: the value the file must hold. Parses every file. */
export function parsedBuiltIns(): BuiltIns {
  return { models: builtInModelCatalogs(), presets: builtInPresets() };
}

/** The file's text for these values: two-space JSON, one trailing newline. */
export function builtInsText(values: BuiltIns): string {
  return `${JSON.stringify(values, null, 2)}\n`;
}

/** Whether the file on disk holds exactly what the shipped YAML parses to now (values, not formatting). */
export function builtInsFresh(file: string = BUILT_INS_FILE): boolean {
  let written: unknown;
  try {
    written = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  return Bun.deepEquals(written, JSON.parse(builtInsText(parsedBuiltIns())), true);
}

if (import.meta.main) {
  // An entry point: the yaml library prints every token it parses when either switch is set.
  clearYamlLogSwitches();
  if (process.argv.includes('--check')) {
    if (builtInsFresh()) {
      console.log('✅ built-ins-fresh');
      process.exit(0);
    }
    console.error(
      '❌ built-ins-fresh · packages/plugins/logins/daemon/lib/built-ins.json: differs from what the shipped YAML ' +
        'parses to; run `bun run packages/plugins/logins/scripts/built-ins.ts`',
    );
    process.exit(1);
  }
  writeFileSync(BUILT_INS_FILE, builtInsText(parsedBuiltIns()));
  const biome = spawnSync('biome', ['format', '--write', BUILT_INS_FILE], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    stdio: 'inherit',
  });
  if (biome.error !== undefined) console.log('biome is not on PATH; the file is written unformatted');
  console.log(`wrote ${BUILT_INS_FILE}`);
}
