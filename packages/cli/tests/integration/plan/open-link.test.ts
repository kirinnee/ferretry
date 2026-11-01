import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openInBrowser } from '../../../src/adapters/plan/open-link';

const MODULE = resolve(import.meta.dir, '../../../src/adapters/plan/open-link.ts');
const URL_TO_OPEN = 'https://app.example.test/#agenda/A8?session=sess-1&x=a b;touch pwned';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-open-link-'));
  dirs.push(dir);
  return dir;
};

/** A launcher that writes each argument it was started with on its own line. */
const recordingLauncher = (dir: string, command: string): string => {
  const log = join(dir, 'argv.txt');
  writeFileSync(join(dir, command), `#!/bin/sh\nfor each in "$@"; do printf '%s\\n' "$each" >> "${log}"; done\n`);
  chmodSync(join(dir, command), 0o755);
  return log;
};

const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`${path} was never written`);
};

/** Runs `openInBrowser` in a child whose PATH is only `path` (Bun reads PATH once, at start-up). */
const runIn = async (path: string, platform: string, patch = ''): Promise<boolean> => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `${patch}const { openInBrowser } = await import(${JSON.stringify(MODULE)});` +
        `process.stdout.write(String(openInBrowser(${JSON.stringify(URL_TO_OPEN)}, ${JSON.stringify(platform)})));`,
    ],
    { env: { PATH: path, HOME: tmpdir() }, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out === 'true';
};

describe('opening a plan link in this host’s browser', () => {
  it('starts the host’s launcher with the link as ONE argument, exactly as given', async () => {
    const dir = scratch();
    const log = recordingLauncher(dir, 'xdg-open');

    expect(await runIn(dir, 'linux')).toBe(true);
    expect(await waitForFile(log)).toBe(`${URL_TO_OPEN}\n`);
  });

  it('uses open on macOS', async () => {
    const dir = scratch();
    const log = recordingLauncher(dir, 'open');

    expect(await runIn(dir, 'darwin')).toBe(true);
    expect(await waitForFile(log)).toBe(`${URL_TO_OPEN}\n`);
  });

  it('is not an error on a host with no launcher on its PATH, or on a platform that has none', async () => {
    const dir = scratch();
    recordingLauncher(dir, 'unrelated');

    expect(await runIn(dir, 'linux')).toBe(false);
    expect(await runIn(dir, 'win32')).toBe(false);
    expect(openInBrowser(URL_TO_OPEN, 'win32')).toBe(false);
  });

  it('says false when the launcher can’t be started', async () => {
    const dir = scratch();
    recordingLauncher(dir, 'xdg-open');

    expect(await runIn(dir, 'linux', "Bun.spawn = () => { throw new Error('spawn failed'); };")).toBe(false);
  });
});
