/**
 * Reading who listens on a port, and stopping one program, against real processes.
 *
 * The listeners here are real programs on real ports. The one that matters most is named `codex` and
 * run with `login`, exactly the command line a leftover Codex sign-in has, so the whole path — port
 * table, `ps`, the lib's decision and the stop — is exercised on what the OS actually reports. The
 * fallbacks are exercised with stand-in tools, so every branch runs on any host.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { systemPortHolders } from '../../../src/adapters/fleet-login/port-holders.ts';
import { isLeftoverCodexLogin } from '../../../src/lib/fleet-login/port-holders.ts';
import { waitFor } from '../support/wait-for.ts';

const temporaryDirectories: string[] = [];
const running: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-port-holders-'));
  temporaryDirectories.push(root);
  return root;
}

/** Write an executable stand-in for one tool. */
async function tool(name: string, body: string): Promise<string> {
  const path = join(await directory(), name);
  await writeFile(path, `#!/bin/sh\n${body}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

/**
 * A real program listening on a free loopback port, run as `<file> login`. Named `codex`, it is what a
 * leftover Codex sign-in looks like; `stubborn` ignores SIGTERM, like a launcher whose child holds on.
 */
async function listener(
  name: string,
  options: { readonly stubborn?: boolean } = {},
): Promise<{ readonly pid: number; readonly port: number }> {
  const path = join(await directory(), name);
  await writeFile(
    path,
    [
      options.stubborn === true ? "process.on('SIGTERM', () => undefined);" : '',
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });",
      'console.log(server.port);',
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
    'utf8',
  );
  const child = Bun.spawn([process.execPath, path, 'login'], { stdout: 'pipe', stderr: 'ignore' });
  running.push(child);
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('the listener exited before it listened');
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return { pid: child.pid, port: Number(text.trim()) };
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const exited = async (pid: number): Promise<boolean> => {
  await waitFor(() => gone(pid), `process ${pid} to exit`);
  return true;
};

describe('systemPortHolders', () => {
  it('should find a leftover Codex sign-in on its port, prove it, and stop it', async () => {
    // Arrange
    const holders = systemPortHolders();
    const leftover = await listener('codex');

    // Act
    const found = await holders.holders([leftover.port]);
    const holder = found?.find(candidate => candidate.pid === leftover.pid);
    const stopped = await holders.stop(leftover.pid);

    // Assert
    should(holder).match({ port: leftover.port, uid: process.getuid?.(), commandLine: /codex login$/u });
    should(holder !== undefined && isLeftoverCodexLogin(holder, holders.ownUid)).be.true();
    should(stopped).be.true();
    should(await exited(leftover.pid)).be.true();
  });

  it('should answer nobody for a port nothing listens on', async () => {
    // Arrange — a port that was free a moment ago: bound, read, and released.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = Number(probe.port);
    await probe.stop(true);

    // Act
    const actual = await systemPortHolders().holders([port]);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should kill a program outright when it ignores the request to stop', async () => {
    // Arrange
    const stubborn = await listener('codex', { stubborn: true });

    // Act
    const stopped = await systemPortHolders({ graceMs: 200 }).stop(stubborn.pid);

    // Assert
    should(stopped).be.true();
    should(await exited(stubborn.pid)).be.true();
  });

  it('should report a stop that reached nobody', async () => {
    // Arrange — a pid that has exited and been reaped.
    const gone = Bun.spawn(['true']);
    await gone.exited;

    // Act
    const actual = await systemPortHolders().stop(gone.pid);

    // Assert
    should(actual).be.false();
  });

  it('should fall back to ss when lsof is not installed, and keep the pid ss names', async () => {
    // Arrange
    const ss = await tool(
      'ss',
      `echo 'LISTEN 0 128 127.0.0.1:1455 0.0.0.0:* users:(("nginx",pid=${String(process.pid)},fd=7))'\n`,
    );
    const ps = await tool('ps', "echo '  0 nginx: master process'\n");

    // Act
    const actual = await systemPortHolders({ lsof: '/nonexistent/lsof', ss, ps }).holders([1455]);

    // Assert
    should(actual).deepEqual([
      { port: 1455, pid: process.pid, name: 'nginx', uid: 0, commandLine: 'nginx: master process' },
    ]);
  });

  it('should keep what the port table said when ps has nothing to add', async () => {
    // Arrange
    const lsof = await tool('lsof', "printf 'p4242\\ncnginx\\nu0\\np4343\\ncproxy\\n'\n");
    const ps = await tool('ps', 'exit 1\n');
    const ss = await tool('ss', "echo 'LISTEN 0 128 [::1]:1455 [::]:*'\n");

    // Act
    const fromLsof = await systemPortHolders({ lsof, ps }).holders([1455]);
    const fromSs = await systemPortHolders({ lsof: '/nonexistent/lsof', ss, ps }).holders([1455]);

    // Assert
    should(fromLsof).deepEqual([
      { port: 1455, pid: 4242, name: 'nginx', uid: 0, commandLine: undefined },
      { port: 1455, pid: 4343, name: 'proxy', uid: undefined, commandLine: undefined },
    ]);
    should(fromSs).deepEqual([
      { port: 1455, pid: undefined, name: 'a program run by another user', uid: undefined, commandLine: undefined },
    ]);
  });

  it('should answer that it cannot tell when neither table can be read', async () => {
    // Arrange
    const failing = await tool('ss', 'exit 1\n');

    // Act
    const missing = await systemPortHolders({ lsof: '/nonexistent/lsof', ss: '/nonexistent/ss' }).holders([1455]);
    const broken = await systemPortHolders({ lsof: '/nonexistent/lsof', ss: failing }).holders([1455]);

    // Assert
    should(missing).be.undefined();
    should(broken).be.undefined();
  });
});
