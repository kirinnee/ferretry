/**
 * Merge-bar line 2: `LOG_TOKENS` / `LOG_STREAM` make the `yaml` library print every token it parses, and a configuration
 * text may carry a credential. `fyd --check` loads every plugin, reads the home and probes the plugin workers, so it is
 * the cheapest run that would dump them.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

test('fyd --check with LOG_TOKENS and LOG_STREAM set prints no yaml token dump', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-token-dump-'));
  parents.push(parent);
  const home = join(parent, 'home');
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(
    join(home, 'home.json'),
    `${JSON.stringify({ format: 1, createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
  );
  const child = Bun.spawnSync(['bun', FYD, '--check'], {
    env: { ...process.env, FY_HOME: home, FY_PORT: '0', LOG_TOKENS: '1', LOG_STREAM: '1' },
    timeout: 90_000,
  });
  const printed = `${child.stdout.toString()}\n${child.stderr.toString()}`;
  expect(child.exitCode).toBe(0);
  // the check ran (so the parse paths were exercised) ...
  expect(printed).toContain('a Ferretry home');
  expect(printed).toContain('workers');
  // ... and neither shape the library prints: a `| <DOC>` / `| "text"` line per token, a `type: "…"` object per CST token.
  // Counted, not matched on the text, so a failure says how many lines leaked and not the whole dump.
  const lines = printed.split('\n');
  expect(lines.filter(line => line.startsWith('| ')).length).toBe(0);
  expect(lines.filter(line => line.startsWith('  type: "')).length).toBe(0);
});
