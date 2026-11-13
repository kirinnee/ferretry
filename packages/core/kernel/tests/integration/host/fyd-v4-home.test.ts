/**
 * The real `fyd` `main()` (a child process) on a Ferretry 4 home that was never carried over: it refuses with 78,
 * names the carry-over prompt, and leaves every entry as it was — mode, size, mtime and content hash. Under launchd
 * (`KeepAlive`) an exit means a respawn every 10 s into the v4 log, so there it says the sentence once and stays idle.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTree, writeV4Home } from './fixtures/v4-home.ts';

const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const PROMPT = 'docs/migration/v4-to-v5-prompt.md';
const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

function fixture(): string {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-v4-home-'));
  parents.push(parent);
  const home = join(parent, 'home');
  writeV4Home(home);
  return home;
}

/** The test's environment with every service-manager marker removed, then `extra`. */
function envFor(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const { XPC_SERVICE_NAME: _x, INVOCATION_ID: _i, FYD_TEST_TIMINGS: _t, ...rest } = process.env;
  return { ...rest, FY_HOME: home, FY_PORT: '0', ...extra };
}

const SHORTENED = '{"leaseSeconds":6,"renewLeadSeconds":2,"maxSessionSeconds":20,"idleDaySeconds":5}';
for (const timings of [undefined, SHORTENED]) {
  test(`a v4 home is refused byte-for-byte untouched: exit 78, the prompt named${timings === undefined ? '' : ' (FYD_TEST_TIMINGS set)'}`, () => {
    const home = fixture();
    const before = snapshotTree(home);
    const child = Bun.spawnSync(['bun', FYD], {
      env: envFor(home, timings === undefined ? {} : { FYD_TEST_TIMINGS: timings }),
      timeout: 60_000,
    });
    expect(child.exitCode).toBe(78);
    expect(child.stderr.toString()).toContain(PROMPT);
    expect(snapshotTree(home)).toEqual(before);
    const names = Object.keys(snapshotTree(home));
    expect(names).not.toContain('home.json');
    expect(names).not.toContain('run');
    expect(names.filter(name => name.startsWith('logs/'))).toEqual(['logs/fyd.log']);
  });
}

test('started by launchd, a refused v4 home is said once and held idle until SIGTERM, then 78: no respawn loop', async () => {
  const home = fixture();
  const before = snapshotTree(home);
  const child = Bun.spawn(['bun', FYD], {
    env: envFor(home, { XPC_SERVICE_NAME: 'com.ferretry.fyd' }),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let said = '';
  const reader = (async () => {
    for await (const chunk of child.stderr) said += new TextDecoder().decode(chunk);
  })();
  try {
    const deadline = Date.now() + 30_000;
    while (!said.includes(PROMPT) && Date.now() < deadline) await Bun.sleep(25);
    expect(said).toContain(PROMPT);
    await Bun.sleep(1500);
    expect(child.exitCode).toBeNull();
    expect(snapshotTree(home)).toEqual(before);
    child.kill('SIGTERM');
    expect(await child.exited).toBe(78);
    await reader;
    expect(said.split(PROMPT).length - 1).toBe(1);
    expect(snapshotTree(home)).toEqual(before);
  } finally {
    child.kill('SIGKILL');
  }
}, 60_000);

test('XPC_SERVICE_NAME=0 (a login shell, not launchd) keeps the plain behaviour: exit 78 at once', () => {
  const home = fixture();
  const child = Bun.spawnSync(['bun', FYD], { env: envFor(home, { XPC_SERVICE_NAME: '0' }), timeout: 60_000 });
  expect(child.exitCode).toBe(78);
});
