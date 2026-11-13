import { expect, test } from 'bun:test';
import type { Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import { LOGINS_CONFIG } from '../../../contract/index.ts';

/**
 * v4 let a login file hold a literal credential; v5 refuses it (an intended difference, docs/design/rebuild-parity.md).
 * The refusal must tell the owner WHICH file, WHICH key and WHAT to do, and must never repeat the value. Through the real
 * kernel config reader and the real Logins schema. Fake values only.
 */

const HOME = '/home/fy';
const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

async function issuesFor(text: string) {
  const fs = state.createMemoryHostFs();
  fs.seed(`${HOME}/config/logins/gateway.yaml`, text);
  const files = config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock('2026-11-08T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'logins', def: LOGINS_CONFIG }],
  });
  await files.reload();
  return files.status().issues;
}

for (const [shape, literal] of [
  ['a long key-shaped literal', 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'],
  ['a short literal', 'fake-token'],
] as const) {
  test(`a login file holding ${shape} is refused naming the file, the key and the remedy, never the value`, async () => {
    const issues = await issuesFor(
      `harness: claude-code\nstore: environment\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${literal}\n`,
    );

    expect(issues.length).toBeGreaterThan(0);
    const said = JSON.stringify(issues);
    expect(said).not.toContain(literal);
    // the file
    expect(issues.some(issue => issue.path.endsWith('logins/gateway.yaml'))).toBe(true);
    // the key
    expect(said).toContain('ANTHROPIC_AUTH_TOKEN');
    // the remedy, with the binary's name the kernel was given (never hand-written in a schema)
    expect(said).toContain('fy secret set NAME');
    expect(said).toContain('${secret:NAME}');
  });
}
