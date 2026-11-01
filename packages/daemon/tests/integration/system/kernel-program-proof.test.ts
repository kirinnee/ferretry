import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  darwinHost,
  KernelProgramProof,
  linuxHost,
  PROC_FILES,
  type ProcessHost,
  type ProcFiles,
  parseStatStart,
  parseStatTty,
  parseStatusUids,
  strangerHolds,
  UNPROVEN,
} from '../../../src/adapters/system/kernel-program-proof.ts';
import { perUserProfile, type ReplaceableDisk, replaceableBy } from '../../../src/adapters/system/replaceable-file.ts';

/**
 * WHO CAN READ A TERMINAL, AGAINST THIS MACHINE: the real `/proc`, the files on this disk and this account
 * (docs/input-requests.md, "Who reads the terminal"). Root-owned trees cannot be made by a test, so those cases walk
 * a described disk; everything this account can make is made for real in a temporary folder. No sudo, no tmux.
 */

const linux = process.platform === 'linux';
const ME = process.getuid?.() ?? 1000;
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => await rm(folder, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'fy-reader-proof-'));
  folders.push(folder);
  return folder;
}

type Uids = { readonly effective: number; readonly real: number };
const SETUID: Uids = { effective: 0, real: 1000 };
const USER: Uids = { effective: 1000, real: 1000 };

function host(facts: {
  readonly uids?: Record<number, Uids | readonly Uids[]>;
  readonly names?: Record<number, string>;
  readonly executables?: Record<number, string>;
}): ProcessHost {
  const read: Record<number, number> = {};
  return {
    uids: async pid => {
      const answer = facts.uids?.[pid];
      if (answer === undefined || !Array.isArray(answer)) return answer as Uids | undefined;
      const index = read[pid] ?? 0;
      read[pid] = index + 1;
      return answer[Math.min(index, answer.length - 1)];
    },
    name: async pid => facts.names?.[pid],
    executable: async pid => facts.executables?.[pid],
    heldElsewhere: async () => false,
  };
}

describe('KernelProgramProof: what a process is proved to run', () => {
  it('should prove a setuid getpass program, read twice, and nothing else setuid', async () => {
    should(await new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: 'sudo' } })).prove(7)).eql({
      name: 'sudo',
      setuidRoot: true,
    });
    should(await new KernelProgramProof(host({ uids: { 7: SETUID }, names: { 7: 'ping' } })).prove(7)).be.undefined();
    should(
      await new KernelProgramProof(host({ uids: { 7: [SETUID, USER] }, names: { 7: 'sudo' } })).prove(7),
    ).be.undefined();
  });

  it('should never prove root outright, a bad pid, an unreadable process, or a name no folder can hold', async () => {
    const root = { effective: 0, real: 0 };
    should(
      await new KernelProgramProof(host({ uids: { 7: root }, executables: { 7: 'sudo' } })).prove(7),
    ).be.undefined();
    should(await new KernelProgramProof(host({})).prove(0)).be.undefined();
    should(await new KernelProgramProof(host({})).prove(7)).be.undefined();
    should(
      await new KernelProgramProof(host({ uids: { 7: USER }, executables: { 7: 'a/b' } })).prove(7),
    ).be.undefined();
    should(await new KernelProgramProof(host({ uids: { 7: USER }, executables: { 7: 'ssh' } })).prove(7)).eql({
      name: 'ssh',
      setuidRoot: false,
    });
  });

  it('should prove nothing, and know nothing, on a platform with no reading wired', async () => {
    const proof = KernelProgramProof.forPlatform('win32', async () => '0 1000');
    should(await proof.prove(process.pid)).be.undefined();
    should(await proof.heldElsewhere('/dev/pts/3')).be.undefined();
    should(await proof.heldElsewhere('not a tty')).be.undefined();
    should(await UNPROVEN.name(1)).be.undefined();
    should(await UNPROVEN.executable(1)).be.undefined();
  });

  it.skipIf(!linux)(
    'should, on Linux, read this process and find bun no system program from a root folder',
    async () => {
      const proof = KernelProgramProof.forPlatform('linux', async () => undefined, ME);
      const readings = linuxHost(ME);
      should(await readings.uids(process.pid)).eql({ real: ME, effective: process.geteuid?.() ?? ME });
      should(await readings.name(process.pid)).be.a.String();
      // The test runner is bun from wherever it was installed: only a root folder's own entry would prove it.
      if (process.execPath.startsWith('/nix/store/') || process.execPath.startsWith('/home/'))
        should(await proof.prove(process.pid)).be.undefined();
      should(await KernelProgramProof.forPlatform('darwin', async () => undefined).prove(process.pid)).be.undefined();
    },
  );
});

describe('the Linux stranger scan on the real /proc', () => {
  it.skipIf(!linux)('should read every fact the scan needs for this very process', async () => {
    should(await PROC_FILES.pids()).containEql(process.pid);
    const fds = await PROC_FILES.fds(process.pid);
    should(fds.length).be.above(0);
    should(await PROC_FILES.link(process.pid, fds[0] as string)).be.a.String();
    const reached = await PROC_FILES.reaches(process.pid, fds[0] as string);
    should(reached.character).be.a.Boolean();
    should(parseStatusUids(await PROC_FILES.status(process.pid))?.real).equal(ME);
    const line = await PROC_FILES.stat(process.pid);
    should(parseStatTty(line)).be.a.Number();
    should(parseStatStart(line)).be.above(0);
    should(await PROC_FILES.executable(process.pid)).equal(process.execPath);
    should(await PROC_FILES.replaceable('/usr/bin/env')).be.false();
    should(await PROC_FILES.device('/dev/null')).be.above(0);
    should((await PROC_FILES.name(process.pid)).trim()).not.be.empty();
    const child = Bun.spawn(['sleep', '5'], { stdout: 'ignore' });
    try {
      should(await PROC_FILES.children(process.pid)).containEql(child.pid);
    } finally {
      child.kill();
    }
  });

  it.skipIf(!linux)(
    'should see /dev/null held by processes whose terminal is another, through the Linux readings',
    async () => {
      should(await linuxHost(ME).heldElsewhere('/dev/null')).be.true();
      should(
        await KernelProgramProof.forPlatform('linux', async () => undefined, ME).heldElsewhere('/dev/null'),
      ).be.true();
    },
  );
});

describe('strangerHolds: who else holds the terminal', () => {
  const TTY = '/dev/pts/9';
  const DEVICE = 34_825;

  interface Proc {
    readonly fds?: Record<string, { readonly link: string; readonly device?: number; readonly character?: boolean }>;
    readonly hidden?: boolean;
    readonly uids?: readonly [real: number, effective: number];
    readonly tty?: number;
    readonly parent?: number;
    readonly started?: number;
    readonly runs?: string;
    readonly comm?: string;
    readonly kids?: readonly number[];
  }

  const files = (procs: Record<number, Proc>): ProcFiles => ({
    device: async () => DEVICE,
    pids: async () => Object.keys(procs).map(Number),
    fds: async pid => {
      const proc = procs[pid];
      if (proc === undefined || proc.hidden === true) throw new Error('EACCES');
      return Object.keys(proc.fds ?? {});
    },
    link: async (pid, fd) => procs[pid]?.fds?.[fd]?.link ?? (await Promise.reject(new Error('ENOENT'))),
    reaches: async (pid, fd) => {
      const found = procs[pid]?.fds?.[fd];
      if (found?.device === undefined) throw new Error('ENOENT');
      return { character: found.character ?? true, device: found.device };
    },
    status: async pid => {
      const proc = procs[pid];
      if (proc?.uids === undefined) throw new Error('ENOENT');
      const [real, effective] = proc.uids;
      const parent = proc.parent === undefined ? '' : `PPid:\t${String(proc.parent)}\n`;
      return `Name:\tx\n${parent}Uid:\t${String(real)}\t${String(effective)}\t${String(effective)}\t${String(effective)}\n`;
    },
    stat: async pid => {
      const proc = procs[pid];
      if (proc === undefined) throw new Error('ENOENT');
      return `${String(pid)} (a (b)) S 1 ${String(pid)} ${String(pid)} ${String(proc.tty ?? 0)} -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${String(proc.started ?? 5000)} 0`;
    },
    executable: async pid => procs[pid]?.runs ?? (await Promise.reject(new Error('EACCES'))),
    replaceable: async path => !path.startsWith('/usr/lib/'),
    name: async pid => procs[pid]?.comm ?? (await Promise.reject(new Error('ENOENT'))),
    children: async pid => procs[pid]?.kids ?? (await Promise.reject(new Error('ENOENT'))),
  });
  const shell: Proc = { fds: { '0': { link: TTY, device: DEVICE } }, uids: [ME, ME], tty: DEVICE };
  const manager: Proc = {
    fds: {},
    uids: [ME, ME],
    runs: '/usr/lib/systemd/systemd',
    started: 798,
    kids: [21],
    parent: 1,
  };
  const helper: Proc = { hidden: true, uids: [ME, ME], parent: 20, started: 801, comm: '(sd-pam)' };
  const scan = async (procs: Record<number, Proc>, account: number | undefined = ME) =>
    await strangerHolds(files(procs), TTY, account, 1);

  it('should find none when only the terminal holds it, past sockets, pipes and other devices', async () => {
    const other = { '1': { link: 'socket:[42]' }, '2': { link: 'pipe:[43]' }, '3': { link: '/dev/null', device: 259 } };
    should(await scan({ 10: shell, 11: { fds: other } })).be.false();
  });

  it('should find a holder of another session, by the device it reaches whatever its text says', async () => {
    should(await scan({ 10: shell, 12: { fds: { '0': { link: '/mnt/pts/9', device: DEVICE } }, tty: 0 } })).be.true();
    should(await scan({ 12: { fds: { '0': { link: TTY } } } })).be.true();
    should(await scan({ 12: { fds: { '0': { link: '/dev/pts/1' } } } })).be.false();
  });

  it('should count a holder whose controlling terminal cannot be read as one elsewhere', async () => {
    const vanishing: ProcFiles = {
      ...files({ 12: { fds: { '0': { link: TTY, device: DEVICE } } } }),
      stat: async () => await Promise.reject(new Error('ENOENT')),
    };
    should(await strangerHolds(vanishing, TTY, ME, 1)).be.true();
  });

  it('should be unknown for a hidden process of this account, and pass over setuid root, others and the gone', async () => {
    should(await scan({ 10: shell, 13: { hidden: true, uids: [ME, ME] } })).be.undefined();
    should(await scan({ 13: { hidden: true, uids: [ME, ME] } }, undefined)).be.undefined();
    should(
      await scan({
        14: { hidden: true, uids: [ME, 0] },
        15: { hidden: true, uids: [ME + 1, ME + 1] },
        16: { hidden: true },
      }),
    ).be.false();
  });

  it("should pass over systemd's login helper only, by its root-owned systemd parent and its start", async () => {
    should(await scan({ 10: shell, 20: manager, 21: helper })).be.false();
    for (const odd of [
      { 20: manager, 21: { ...helper, started: 98_000 } },
      { 20: manager, 21: { ...helper, started: 700 } },
      { 20: manager, 21: { ...helper, parent: 1 } },
      { 20: manager, 21: { ...helper, parent: undefined } },
      { 20: { ...manager, runs: '/home/me/systemd' }, 21: helper },
      { 20: { ...manager, runs: '/usr/lib/systemd/bash' }, 21: helper },
      { 20: { ...manager, runs: undefined }, 21: helper },
      { 21: helper },
    ] as Record<number, Proc>[])
      should(await scan(odd)).be.undefined();
    // R1: only the manager's EARLIEST child, and only under its own name. A second hidden child of the manager that
    // started within the same first second stays unknown, and so does one that took the name.
    const second: Proc = { ...helper, started: 820 };
    should(await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: second })).be.undefined();
    should(
      await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: { fds: {}, started: 801 } }),
    ).be.undefined();
    should(
      await scan({
        10: shell,
        20: { ...manager, kids: [21, 22] },
        21: { ...helper, started: 830 },
        22: { fds: {}, started: 801 },
      }),
    ).be.undefined();
    should(
      await scan({ 10: shell, 20: { ...manager, kids: [21, 22] }, 21: helper, 22: { fds: {}, started: 900 } }),
    ).be.false();
    should(await scan({ 10: shell, 20: { ...manager, kids: [21, 23] }, 21: helper })).be.false();
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, comm: 'sd-pam' } })).be.undefined();
    should(await scan({ 10: shell, 20: manager, 21: { ...helper, comm: undefined } })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, kids: [22] }, 21: helper })).be.undefined();
    should(await scan({ 10: shell, 20: { ...manager, kids: undefined }, 21: helper })).be.undefined();
  });

  it('should say held elsewhere over unknown, and leave the daemon itself out', async () => {
    const stranger: Proc = { fds: { '0': { link: TTY, device: DEVICE } }, tty: 0 };
    should(await scan({ 13: { hidden: true, uids: [ME, ME] }, 12: stranger })).be.true();
    should(await scan({ 1: stranger })).be.false();
  });
});

describe('the macOS readings, through a stand-in for ps and lsof', () => {
  const runner = (answers: Record<string, string | undefined>) => async (argv: readonly string[]) =>
    answers[argv.join(' ')];

  it('should read the uids and the name from ps, and say nothing it cannot read', async () => {
    const readings = darwinHost(runner({ 'ps -o uid=,ruid= -p 7': '0 501\n', 'ps -o comm= -p 7': '/usr/bin/sudo\n' }));
    should(await readings.uids(7)).eql({ effective: 0, real: 501 });
    should(await readings.name(7)).equal('sudo');
    should(await readings.uids(8)).be.undefined();
    should(await readings.name(8)).be.undefined();
    should(await readings.executable(7)).be.undefined();
  });

  it('should tell who else holds a terminal from lsof and ps, and fail closed on any missing answer', async () => {
    const tty = '/dev/ttys003';
    const held = (lsof: string | undefined, ps?: string) =>
      darwinHost(runner({ 'lsof -t -- /dev/ttys003': lsof, 'ps -o pid=,tty= -p 100,102': ps })).heldElsewhere(tty);
    should(await held('100\n102\n', '100 ttys003\n102 ttys003\n')).be.false();
    should(await held('100\n102\n', '100 ttys003\n102 ttys009\n')).be.true();
    should(await held('100\n102\n', '100 ttys003\n\n102 ??\n')).be.true();
    should(await held('100\n102\n')).be.undefined();
    should(await held(undefined)).be.undefined();
    should(await held('\n')).be.undefined();
  });
});

describe('replaceableBy on this disk', () => {
  it('should call a file this account made replaceable, through any link, and a link loop or a relative path too', async () => {
    const folder = await scratch();
    const file = join(folder, 'gh');
    await writeFile(file, '#!/bin/sh\n');
    await symlink(file, join(folder, 'link'));
    await symlink(join(folder, 'loop'), join(folder, 'loop'));
    should(await replaceableBy(ME, file)).be.true();
    should(await replaceableBy(ME, join(folder, 'link'))).be.true();
    should(await replaceableBy(ME, join(folder, 'loop'))).be.true();
    should(await replaceableBy(ME, 'relative/gh')).be.true();
    should(await replaceableBy(ME, join(folder, 'missing'))).be.true();
  });

  it.skipIf(!linux)('should not call a root system program replaceable, by any spelling of its path', async () => {
    should(await replaceableBy(ME, '/usr/bin/env')).be.false();
    should(await replaceableBy(ME, '/usr/bin/../bin/./env')).be.false();
    should(await replaceableBy(ME, '/../usr/bin/env')).be.false();
  });

  it('should walk a described root disk: every hop, the Nix store only from a root folder', async () => {
    type Node = { readonly uid: number; readonly mode?: number; readonly to?: string };
    const described = (nodes: Record<string, Node>): ReplaceableDisk => ({
      lstat: async path => {
        const node = nodes[path];
        if (node === undefined) throw new Error(`ENOENT ${path}`);
        return { uid: node.uid, mode: node.mode ?? 0o755, isSymbolicLink: () => node.to !== undefined };
      },
      readlink: async path => nodes[path]?.to ?? (await Promise.reject(new Error('EINVAL'))),
    });
    const disk: Record<string, Node> = {
      '/': { uid: 0 },
      '/usr': { uid: 0 },
      '/usr/bin': { uid: 0 },
      '/usr/bin/gh': { uid: 0, to: '/nix/store/aaa-gh/bin/gh' },
      '/usr/bin/bad': { uid: 0, to: '/home/me/link' },
      '/home': { uid: 0 },
      '/home/me': { uid: ME, mode: 0o700 },
      '/home/me/link': { uid: ME, to: '/usr/bin/gh' },
      '/nix': { uid: 0 },
      '/nix/store': { uid: 0, mode: 0o1775 },
      '/nix/store/aaa-gh': { uid: 0 },
      '/nix/store/aaa-gh/bin': { uid: 0 },
      '/nix/store/aaa-gh/bin/gh': { uid: 0 },
      '/nix/store/zzz-gh': { uid: 0 },
      '/nix/store/zzz-gh/bin': { uid: 0 },
      '/nix/store/zzz-gh/bin/gh': { uid: 0 },
      '/tmp': { uid: 0, mode: 0o777 },
      '/tmp/x': { uid: 0 },
    };
    const walk = async (path: string, account: number | undefined = ME) =>
      await replaceableBy(account, path, described(disk), ['/usr/bin']);
    should(await walk('/usr/bin/gh')).be.false();
    should(await walk('/nix/store/aaa-gh/bin/gh')).be.false();
    should(await walk('/nix/store/zzz-gh/bin/gh')).be.true();
    should(await walk('/usr/bin/bad')).be.true();
    should(await walk('/tmp/x')).be.true();
    should(await walk('/usr/bin/gh', undefined)).be.false();
    should(
      await replaceableBy(ME, '/x', { ...described(disk), lstat: async () => await Promise.reject(new Error('EIO')) }),
    ).be.true();
    should(
      await replaceableBy(
        ME,
        '/usr/bin/gh',
        { ...described(disk), readlink: async () => await Promise.reject(new Error('EIO')) },
        ['/usr/bin'],
      ),
    ).be.true();
  });

  it('should name the per-user system profile only for a name that can be one folder', () => {
    should(perUserProfile('kirin')).eql(['/etc/profiles/per-user/kirin/bin']);
    should(perUserProfile(undefined)).eql([]);
    should(perUserProfile('../etc')).eql([]);
  });

  it('should call a folder this account made replaceable', async () => {
    const folder = await scratch();
    await mkdir(join(folder, 'bin'));
    should(await replaceableBy(ME, join(folder, 'bin'))).be.true();
  });
});
