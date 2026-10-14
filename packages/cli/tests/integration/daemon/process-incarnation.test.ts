import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { HostProcessIncarnations } from '../../../src/adapters/daemon/process-incarnation.ts';

/**
 * Which process a pid number means, read from the host.
 *
 * The `/proc` answers run against this host's own `/proc` where it has one, because a fixture can only
 * show the parser agrees with itself. The macOS branch is reached on any host by pointing `/proc` at a
 * directory that is not one and handing it scripted `sysctl` and `ps`, the same way `process.test.ts`
 * reaches `lsof`.
 */

const roots = new Set<string>();

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-incarnation-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

/** A stand-in command that prints `stdout` and exits with `code`, whatever it is asked. */
async function scripted(root: string, name: string, stdout: string, code: number): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${String(code)}\n`);
  await chmod(path, 0o755);
  return path;
}

const hasProc = await Bun.file('/proc/self/stat').exists();

describe.if(hasProc)('process identity from /proc', () => {
  it('should name this boot and PID namespace, and a stable start for a live process', async () => {
    // Arrange
    const subject = new HostProcessIncarnations(new BunDaemonProcess());

    // Act
    const scope = await subject.scope();
    const first = await subject.observe(process.pid);
    const second = await subject.observe(process.pid);

    // Assert — the start time is clock ticks since boot, so it never moves for one process.
    should(scope?.boot).match(/^[0-9a-f-]{36}$/u);
    should(scope?.namespace).match(/^pid:\[\d+\]$/u);
    should(first).deepEqual(second);
    should(first.kind).equal('running');
  });

  it('should call a process that has exited gone', async () => {
    // Arrange — a child that has been reaped is a number nothing holds any more.
    const child = Bun.spawn(['true']);
    await child.exited;

    // Act + Assert
    should(await new HostProcessIncarnations(new BunDaemonProcess()).observe(child.pid)).deepEqual({ kind: 'gone' });
  });
});

describe('process identity from a /proc-shaped directory', () => {
  async function fakeProc(): Promise<string> {
    const root = await createTemporaryRoot();
    await mkdir(join(root, 'self'), { recursive: true });
    await writeFile(join(root, 'self', 'stat'), '1 (self) S 0');
    await mkdir(join(root, 'sys', 'kernel', 'random'), { recursive: true });
    return root;
  }

  it('should count stat fields from the last parenthesis, whatever the command name holds', async () => {
    // Arrange — a command name with spaces and a closing parenthesis inside it.
    const proc = await fakeProc();
    await mkdir(join(proc, '77'));
    const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 4)), '424242', '0'];
    await writeFile(join(proc, '77', 'stat'), `77 (a ) b (c) ${fields.join(' ')}`);

    // Act + Assert
    should(await new HostProcessIncarnations(new BunDaemonProcess(), { procDirectory: proc }).observe(77)).deepEqual({
      kind: 'running',
      start: '424242',
    });
  });

  it('should decide nothing from a stat it cannot read or cannot parse', async () => {
    // Arrange — a stat that is a directory, and one too short to hold a start time.
    const proc = await fakeProc();
    await mkdir(join(proc, '78', 'stat'), { recursive: true });
    await mkdir(join(proc, '79'));
    await writeFile(join(proc, '79', 'stat'), '79 (short) S 1');
    const subject = new HostProcessIncarnations(new BunDaemonProcess(), { procDirectory: proc });

    // Act + Assert
    should(await subject.observe(78)).deepEqual({ kind: 'unknown' });
    should(await subject.observe(79)).deepEqual({ kind: 'unknown' });
  });

  it('should name no scope without both a boot id and a namespace', async () => {
    // Arrange
    const proc = await fakeProc();
    const subject = new HostProcessIncarnations(new BunDaemonProcess(), { procDirectory: proc });
    await writeFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'boot-1\n');

    // Act + Assert — a boot id with no namespace link, then a link beside an empty boot id.
    should(await subject.scope()).be.undefined();
    await mkdir(join(proc, 'self', 'ns'));
    await symlink('pid:[4026531836]', join(proc, 'self', 'ns', 'pid'));
    should(await subject.scope()).deepEqual({ boot: 'boot-1', namespace: 'pid:[4026531836]' });
    await writeFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), '\n');
    should(await subject.scope()).be.undefined();
  });
});

describe('process identity without /proc', () => {
  async function darwin(
    ps: { readonly stdout: string; readonly code: number },
    sysctl = { stdout: 'uuid-1\n', code: 0 },
  ) {
    const root = await createTemporaryRoot();
    return new HostProcessIncarnations(new BunDaemonProcess(), {
      procDirectory: join(root, 'no-proc'),
      sysctl: await scripted(root, 'sysctl', sysctl.stdout, sysctl.code),
      ps: await scripted(root, 'ps', ps.stdout, ps.code),
    });
  }

  it('should take the boot session as the whole scope, because macOS has no PID namespaces', async () => {
    // Act + Assert
    should(await (await darwin({ stdout: '', code: 1 })).scope()).deepEqual({ boot: 'uuid-1', namespace: 'darwin' });
    should(await (await darwin({ stdout: '', code: 1 }, { stdout: '', code: 0 })).scope()).be.undefined();
    should(await (await darwin({ stdout: '', code: 1 }, { stdout: 'uuid', code: 1 })).scope()).be.undefined();
  });

  it.each([
    {
      name: 'a start time',
      ps: { stdout: 'Tue Oct 14 10:00:00 2026\n', code: 0 },
      expected: { kind: 'running', start: 'Tue Oct 14 10:00:00 2026' },
    },
    { name: 'nothing, for a pid that does not exist', ps: { stdout: '', code: 1 }, expected: { kind: 'gone' } },
    { name: 'anything else', ps: { stdout: 'ps: illegal option', code: 2 }, expected: { kind: 'unknown' } },
  ])('should read $name from ps', async ({ ps, expected }) => {
    // Act + Assert
    should(await (await darwin(ps)).observe(4_242)).deepEqual(expected);
  });

  it('should decide nothing on a host with no ps at all', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const subject = new HostProcessIncarnations(new BunDaemonProcess(), {
      procDirectory: join(root, 'no-proc'),
      ps: join(root, 'no-such-ps'),
    });

    // Act + Assert
    should(await subject.observe(4_242)).deepEqual({ kind: 'unknown' });
  });
});
