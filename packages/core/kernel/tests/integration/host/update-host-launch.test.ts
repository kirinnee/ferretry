/** The update launch on the real machine: a real detached child, a real log, and the refusals around it. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { updateHostFor, undeclaredUpdateHost } from '../../../host/adapters/update-host.ts';

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/fy-update-launch-`);
  directories.push(directory);
  return directory;
}

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('the detached update never finished');
}

const FILES = { report: 'update/report.json', log: 'update.log' };

describe('updateHostFor with the real detached spawn', () => {
  test('starts the client beside argv0 as a detached child whose three streams go to the private log', async () => {
    const home = await scratch();
    const bin = await scratch();
    // the client prints what it was given and the home it was told about
    await writeFile(`${bin}/fy`, '#!/bin/sh\necho "args:$*"\necho "home:$FY_HOME"\necho "oops" >&2\n');
    await chmod(`${bin}/fy`, 0o755);
    const port = updateHostFor({
      home,
      binary: 'fy',
      release: '5.0.0',
      process: {
        argv0: `${bin}/fyd`,
        execPath: `${bin}/fyd`,
        main: '/$bunfs/root/fyd',
        workingDirectory: '/',
        platform: 'linux',
      },
      environment: { PATH: '/usr/bin:/bin', FY_UPDATE_CHECK: 'on' },
    })('updates', FILES);
    expect(port.compiled).toBe(true);
    expect(port.checks).toBe(true);
    expect(await port.launchUpdate('5.1.0')).toEqual({ kind: 'started' });
    const log = `${home}/state/updates/update.log`;
    await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('oops'));
    const text = await readFile(log, 'utf8');
    expect(text).toContain(`args:update --run --to 5.1.0 --report ${home}/state/updates/update/report.json`);
    expect(text).toContain(`home:${home}`);
    expect((await stat(log)).mode & 0o777).toBe(0o600);
  });

  test('a launch the shell cannot start is reported as failed with its reason, and the switch turns the checks off', async () => {
    const home = await scratch();
    const missing = await scratch();
    const port = updateHostFor({
      home,
      binary: 'fy',
      release: '5.0.0',
      process: {
        argv0: `${missing}/fyd`,
        execPath: `${missing}/fyd`,
        main: '/$bunfs/root/fyd',
        workingDirectory: '/',
        platform: 'linux',
      },
      environment: { PATH: '/usr/bin', FY_UPDATE_CHECK: 'off' },
    })('updates', FILES);
    expect(port.checks).toBe(false);
    const launched = await port.launchUpdate('5.1.0');
    expect(launched.kind).toBe('failed');
  });

  test('a target that is not a release number is refused before anything is made', async () => {
    const home = await scratch();
    const port = updateHostFor({ home, binary: 'fy', release: '5.0.0' })('updates', FILES);
    expect(await port.launchUpdate('latest; rm -rf /')).toEqual({
      kind: 'failed',
      reason: 'latest; rm -rf / is not a release number',
    });
    await expect(stat(`${home}/state/updates`)).rejects.toThrow();
  });

  test('a state folder that cannot be made fails the launch with a non-Error reason kept as text', async () => {
    const home = await scratch();
    const port = updateHostFor({
      home,
      binary: 'fy',
      release: '5.0.0',
      spawn: () => {
        throw 'not an Error value';
      },
    })('updates', FILES);
    expect(await port.launchUpdate('v5.1.0')).toEqual({ kind: 'failed', reason: 'not an Error value' });
  });

  test('without declared facts it reads this process: a source run is not compiled, and the executable resolves through links', async () => {
    const home = await scratch();
    const port = updateHostFor({ home, binary: 'fy', release: '5.0.0' })('updates', FILES);
    expect(port.compiled).toBe(false);
    expect(port.checks).toBe(false);
    const facts = await port.executable();
    expect(facts.execPath).toBe(process.execPath);
    expect(facts.resolvedExecPath).toBe(await realpath(process.execPath));
  });

  test('an executable whose link cannot be resolved is reported by its own path', async () => {
    const home = await scratch();
    const dangling = `${await scratch()}/gone`;
    await symlink(`${dangling}.target`, dangling);
    const port = updateHostFor({
      home,
      binary: 'fy',
      release: '5.0.0',
      process: { argv0: dangling, execPath: dangling, main: '/src/main.ts', workingDirectory: '/', platform: 'linux' },
    })('updates', FILES);
    expect((await port.executable()).resolvedExecPath).toBe(dangling);
  });

  test('a declared report or log that could leave the state folder gets the refusing port', async () => {
    const home = await scratch();
    const open = updateHostFor({ home, binary: 'fy', release: '5.0.0' });
    for (const files of [
      { report: '../report.json', log: 'update.log' },
      { report: 'report.json', log: 'logs/*.log' },
    ]) {
      const port = open('updates', files);
      await expect(port.executable()).rejects.toThrow(
        'updates declared a report or log path that is not one file inside its own state folder.',
      );
      expect(await port.launchUpdate('5.1.0')).toEqual({
        kind: 'failed',
        reason: 'updates declared a report or log path that is not one file inside its own state folder.',
      });
    }
  });
});

describe('undeclaredUpdateHost', () => {
  test('refuses both facts and launches, saying the permission was not declared', async () => {
    const port = undeclaredUpdateHost('acme', '5.0.0');
    expect(port.release).toBe('5.0.0');
    expect(port.checks).toBe(false);
    await expect(port.executable()).rejects.toThrow('acme did not declare permissions.updateHost.');
    expect(await port.launchUpdate('5.1.0')).toEqual({
      kind: 'failed',
      reason: 'acme did not declare permissions.updateHost.',
    });
  });
});
