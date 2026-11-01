import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInBrowser } from '../../../src/adapters/plan/open-link';

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

const install = (dir: string, command: string, body: string): void => {
  writeFileSync(join(dir, command), body);
  chmodSync(join(dir, command), 0o755);
};

/** A launcher that writes each argument it was started with on its own line. */
const recordingLauncher = (dir: string, command: string): string => {
  const log = join(dir, 'argv.txt');
  install(dir, command, `#!/bin/sh\nfor each in "$@"; do printf '%s\\n' "$each" >> "${log}"; done\n`);
  return log;
};

/** The launcher's `>>` creates the file before `printf` fills it, so a complete log is one that ends in a newline. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const content = readFileSync(path, 'utf8');
      if (content.endsWith('\n')) return content;
    } catch {
      // not created yet
    }
    await Bun.sleep(20);
  }
  throw new Error(`${path} was never completed`);
};

describe('opening a plan link in this host’s browser', () => {
  it('starts the host’s launcher with the link as ONE argument, exactly as given', async () => {
    const dir = scratch();
    const log = recordingLauncher(dir, 'xdg-open');

    expect(openInBrowser(URL_TO_OPEN, 'linux', { PATH: dir })).toBe(true);
    expect(await waitForFile(log)).toBe(`${URL_TO_OPEN}\n`);
  });

  it('uses open on macOS', async () => {
    const dir = scratch();
    const log = recordingLauncher(dir, 'open');

    expect(openInBrowser(URL_TO_OPEN, 'darwin', { PATH: dir })).toBe(true);
    expect(await waitForFile(log)).toBe(`${URL_TO_OPEN}\n`);
  });

  it('is not an error on a host with no launcher on its PATH, or on a platform that has none', () => {
    const dir = scratch();
    recordingLauncher(dir, 'unrelated');

    expect(openInBrowser(URL_TO_OPEN, 'linux', { PATH: dir })).toBe(false);
    expect(openInBrowser(URL_TO_OPEN, 'linux', {})).toBe(false);
    expect(openInBrowser(URL_TO_OPEN, 'win32', { PATH: dir })).toBe(false);
    expect(openInBrowser(URL_TO_OPEN, 'win32')).toBe(false);
  });

  it('says false when the launcher is found but can’t be started', () => {
    const dir = scratch();
    install(dir, 'xdg-open', '#!/nonexistent/interpreter\n');

    expect(openInBrowser(URL_TO_OPEN, 'linux', { PATH: dir })).toBe(false);
  });
});
