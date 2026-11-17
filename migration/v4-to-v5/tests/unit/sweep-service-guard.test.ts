import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertScopeOwned,
  assertServiceOwned,
  judgeScope,
  judgeService,
  parseUnitShow,
  stopScope,
  stopService,
  type GuardPorts,
  type UnitInfo,
} from '../../fixtures/sweep/service-guard.ts';

const LOCK = '/tmp/claude-1000/sweep/slot3/v5/daemon.lock';
const ENV_FILE = '/tmp/claude-1000/sweep/slot3/v5/fyd.env';
const SOCKET = '/tmp/claude-1000/sweep/slot3/v5/home/state/terminals/tmux.sock';
const who = { name: 'fy5-slot3.service', lock: LOCK, envFile: ENV_FILE };

const execStart = (...argv: string[]): string =>
  `ExecStart={ path=${argv[0] ?? ''} ; argv[]=${argv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

const show = (fields: Partial<Record<string, string>>): string =>
  Object.entries({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: '0',
    ControlGroup: '/user.slice/x.service',
    ExecStart: '',
    ...fields,
  })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');

const ownArgv = execStart('/bin/sh', '/repo/fyd-exec.sh', '/usr/bin/env', ENV_FILE, '/b/fyd', '--port', '7609');
const foreignArgv = execStart('/usr/bin/sleep', '1000');

interface Fake {
  readonly ports: GuardPorts;
  readonly calls: string[][];
  readonly lockStops: string[];
}

function fake(opts: {
  readonly units?: Readonly<Record<string, string>>;
  readonly holders?: readonly number[];
  readonly cgroupPids?: Readonly<Record<string, readonly number[]>>;
  /** Control groups whose cgroup.procs cannot be read. */
  readonly unreadableCgroups?: readonly string[];
  readonly tmuxPid?: number;
  readonly panes?: readonly number[];
  readonly parents?: Readonly<Record<number, number>>;
}): Fake {
  const calls: string[][] = [];
  const lockStops: string[] = [];
  const ports: GuardPorts = {
    systemctl: async args => {
      calls.push([...args]);
      if (args[0] === 'show') {
        const text = opts.units?.[args[1] ?? ''];
        return text === undefined
          ? { code: 0, out: 'LoadState=not-found\n', err: '' }
          : { code: 0, out: text, err: '' };
      }
      return { code: 0, out: '', err: '' };
    },
    holders: async () => [...(opts.holders ?? [])],
    stopByLock: async lock => {
      lockStops.push(lock);
    },
    cgroupPids: async cgroup =>
      opts.unreadableCgroups?.includes(cgroup) === true ? undefined : [...(opts.cgroupPids?.[cgroup] ?? [])],
    tmuxServerPid: async () => opts.tmuxPid,
    panePids: async () => [...(opts.panes ?? [])],
    parentOf: async pid => opts.parents?.[pid],
    log: () => undefined,
    refuse: sentence => {
      throw new Error(sentence);
    },
  };
  return { ports, calls, lockStops };
}

const mutating = (calls: readonly string[][]): string[][] => calls.filter(call => call[0] !== 'show');

describe('parseUnitShow', () => {
  test('reads state, MainPID, cgroup and the ExecStart argv', () => {
    const info = parseUnitShow(show({ MainPID: '4242', ExecStart: ownArgv }));
    expect(info.loaded).toBe(true);
    expect(info.mainPid).toBe(4242);
    expect(info.execArgv).toContain(ENV_FILE);
    expect(info.execArgv[0]).toBe('/bin/sh');
  });
  test('a unit that does not exist is not loaded and has no argv', () => {
    const info = parseUnitShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n');
    expect(info.loaded).toBe(false);
    expect(info.execArgv).toEqual([]);
  });
});

describe('judgeService', () => {
  const base: UnitInfo = {
    loaded: true,
    active: 'active',
    sub: 'running',
    mainPid: 100,
    cgroup: '',
    execArgv: [],
  };
  test('a MainPID holding this slot lock is this slot daemon', () => {
    expect(judgeService(base, who, [100]).owned).toBe(true);
  });
  test('a MainPID that does not hold the lock and a foreign ExecStart is foreign', () => {
    expect(judgeService({ ...base, execArgv: ['/usr/bin/sleep'] }, who, []).owned).toBe(false);
    expect(judgeService(base, who, [555]).owned).toBe(false);
  });
  test('MainPID=0 (activating / auto-restart) is judged by the ExecStart naming this slot env file', () => {
    const restarting = { ...base, active: 'activating', sub: 'auto-restart', mainPid: 0 };
    expect(judgeService({ ...restarting, execArgv: ['/bin/sh', 'w', ENV_FILE] }, who, []).owned).toBe(true);
    expect(judgeService({ ...restarting, execArgv: ['/bin/sh', 'w', '/tmp/other/fyd.env'] }, who, []).owned).toBe(
      false,
    );
  });
  test('this slot env file named, but another pid holds the lock: refused', () => {
    const verdict = judgeService({ ...base, mainPid: 0, execArgv: [ENV_FILE] }, who, [777]);
    expect(verdict.owned).toBe(false);
  });
});

describe('stopService: ownership before STOP', () => {
  test('a foreign live unit (foreign MainPID) is refused: no stop, no reset-failed, no lock fallback', async () => {
    const f = fake({ units: { [who.name]: show({ MainPID: '4242', ExecStart: foreignArgv }) }, holders: [] });
    await expect(stopService(f.ports, who, '5.0 daemon')).rejects.toThrow(/belongs to something else/u);
    expect(mutating(f.calls)).toEqual([]);
    expect(f.lockStops).toEqual([]);
  });
  test('a unit whose MainPID holds ANOTHER lock is refused', async () => {
    const f = fake({ units: { [who.name]: show({ MainPID: '4242', ExecStart: foreignArgv }) }, holders: [9] });
    await expect(stopService(f.ports, who, 'x')).rejects.toThrow(/left alone/u);
    expect(mutating(f.calls)).toEqual([]);
    expect(f.lockStops).toEqual([]);
  });
  test('a dead unit that is not this slot is refused too: nothing is reset', async () => {
    const f = fake({
      units: { [who.name]: show({ ActiveState: 'failed', SubState: 'failed', ExecStart: foreignArgv }) },
    });
    await expect(stopService(f.ports, who, 'x')).rejects.toThrow(/left alone/u);
    expect(mutating(f.calls)).toEqual([]);
  });
  test('an own unit (its MainPID holds the lock) is stopped and reset', async () => {
    const f = fake({ units: { [who.name]: show({ MainPID: '4242', ExecStart: ownArgv }) }, holders: [4242] });
    await stopService(f.ports, who, '5.0 daemon');
    expect(mutating(f.calls)).toEqual([
      ['stop', who.name],
      ['reset-failed', who.name],
    ]);
  });
  test('an own unit in auto-restart (MainPID=0) is stopped, identified by its ExecStart', async () => {
    const f = fake({
      units: { [who.name]: show({ ActiveState: 'activating', SubState: 'auto-restart', ExecStart: ownArgv }) },
    });
    await stopService(f.ports, who, '5.0 daemon');
    expect(mutating(f.calls)).toEqual([
      ['stop', who.name],
      ['reset-failed', who.name],
    ]);
  });
  test('no unit at all: only the lock holder (this slot own lock) is stopped', async () => {
    const f = fake({ holders: [31] });
    await stopService(f.ports, who, '5.0 daemon');
    expect(mutating(f.calls)).toEqual([]);
    expect(f.lockStops).toEqual([LOCK]);
  });
  test('assertServiceOwned refuses before anything else can run', async () => {
    const f = fake({ units: { [who.name]: show({ MainPID: '4242', ExecStart: foreignArgv }) } });
    await expect(assertServiceOwned(f.ports, who)).rejects.toThrow(/refusing/u);
  });
});

describe('terminals scope: ownership before STOP', () => {
  const scope = { name: 'fy5-slot3-terminals.scope', socket: SOCKET };
  const cg = '/user.slice/fy5-slot3-terminals.scope';
  const scopeShow = show({ ControlGroup: cg });

  test('a scope holding a stranger process is refused: no kill, no stop, no reset', async () => {
    const f = fake({
      units: { [scope.name]: scopeShow },
      cgroupPids: { [cg]: [900] },
      tmuxPid: 500,
      panes: [501],
      parents: { 900: 1 },
    });
    let killed = false;
    await expect(
      stopScope(f.ports, scope, async () => {
        killed = true;
      }),
    ).rejects.toThrow(/neither this slot's tmux server/u);
    expect(killed).toBe(false);
    expect(mutating(f.calls)).toEqual([]);
  });
  test('a scope with processes but no tmux server on this slot socket is refused', async () => {
    const f = fake({ units: { [scope.name]: scopeShow }, cgroupPids: { [cg]: [900] } });
    await expect(assertScopeOwned(f.ports, scope)).rejects.toThrow(/cannot be shown to be this slot's/u);
  });
  test('the tmux server, its panes and their children are this slot own: killed, stopped, reset', async () => {
    const f = fake({
      units: { [scope.name]: scopeShow },
      cgroupPids: { [cg]: [500, 501, 650] },
      tmuxPid: 500,
      panes: [501],
      parents: { 650: 501, 501: 500 },
    });
    let killed = false;
    await stopScope(f.ports, scope, async () => {
      killed = true;
    });
    expect(killed).toBe(true);
    expect(mutating(f.calls)).toEqual([
      ['stop', scope.name],
      ['reset-failed', scope.name],
    ]);
  });
  test('a scope whose cgroup.procs cannot be read is foreign: no kill, no stop, no reset', async () => {
    const f = fake({ units: { [scope.name]: scopeShow }, unreadableCgroups: [cg], tmuxPid: 500, panes: [501] });
    let killed = false;
    await expect(
      stopScope(f.ports, scope, async () => {
        killed = true;
      }),
    ).rejects.toThrow(/cgroup\.procs cannot be read/u);
    expect(killed).toBe(false);
    expect(mutating(f.calls)).toEqual([]);
    expect((await judgeScope(f.ports, scope, parseUnitShow(scopeShow))).owned).toBe(false);
  });
  test('an empty scope has nothing to protect', async () => {
    const f = fake({ units: { [scope.name]: scopeShow } });
    const info = parseUnitShow(scopeShow);
    expect((await judgeScope(f.ports, scope, info)).owned).toBe(true);
  });
});

describe('fyd-exec.sh: the allow-list holds on every exec', () => {
  const wrapper = join(import.meta.dir, '../../fixtures/sweep/fyd-exec.sh');
  const envProgram = Bun.which('env') ?? '/usr/bin/env';

  async function runWrapper(
    body: string,
    inherited: Record<string, string>,
    program: readonly string[] = [envProgram],
  ): Promise<{ code: number; out: string; err: string; dir: string; pid: number }> {
    const dir = await mkdtemp(join(tmpdir(), 'fyd-exec-'));
    const file = join(dir, 'fyd.env');
    await writeFile(file, body, { mode: 0o600 });
    await chmod(file, 0o600);
    const child = Bun.spawn(['/bin/sh', wrapper, envProgram, file, ...program], {
      env: { PATH: '/usr/bin:/bin', ...inherited },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err, dir, pid: child.pid };
  }

  test('an inherited extra variable (made-up name and value) never reaches the child', async () => {
    const r = await runWrapper('HOME=/tmp/h\nFY_HOME=/tmp/fy\n', {
      SWEEP_MADE_UP_EXTRA: 'made-up-value-123',
      ANOTHER_ONE: 'x',
    });
    await rm(r.dir, { recursive: true });
    expect(r.code).toBe(0);
    expect(
      r.out
        .split('\n')
        .filter(line => line !== '')
        .sort(),
    ).toEqual(['FY_HOME=/tmp/fy', 'HOME=/tmp/h']);
    expect(r.out).not.toContain('made-up');
  });

  test('values are taken literally: quotes, $, backticks and spaces are not expanded', async () => {
    const r = await runWrapper('A=$(echo pwned) `id` "q" \'s\' $HOME  x\nB=a=b\n', {});
    await rm(r.dir, { recursive: true });
    expect(r.out).toContain('A=$(echo pwned) `id` "q" \'s\' $HOME  x\n');
    expect(r.out).toContain('B=a=b\n');
  });

  test('the program is exec ed: its pid is the wrapper pid', async () => {
    const r = await runWrapper('X=1\n', {}, ['/bin/sh', '-c', 'echo "$$"']);
    await rm(r.dir, { recursive: true });
    // `exec env -i … /bin/sh -c`: the shell the child runs is the same process as the one Bun spawned.
    expect(r.out.trim()).toBe(String(r.pid));
  });

  test.each([
    ['a credential-shaped name', 'GH_TOKEN=nope\n'],
    ['a name ending in _KEY', 'MY_API_KEY=nope\n'],
    ['a name that is not a variable name', '1BAD=x\n'],
    ['a line without "="', 'JUSTWORDS\n'],
    ['an empty file', ''],
  ])('fails closed (exit 78, no value printed) on %s', async (_label, body) => {
    const r = await runWrapper(body, {});
    await rm(r.dir, { recursive: true });
    expect(r.code).toBe(78);
    expect(r.out).toBe('');
    expect(r.err).not.toContain('nope');
  });

  test('fails closed when the env file is missing or a link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fyd-exec-'));
    const missing = Bun.spawn(['/bin/sh', wrapper, envProgram, join(dir, 'nope.env'), envProgram], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await missing.exited).toBe(78);
    await rm(dir, { recursive: true });
  });

  test('fails closed (78) when the env file is a symbolic link, even to a good 0600 file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fyd-exec-'));
    const real = join(dir, 'real.env');
    await writeFile(real, 'X=1\n', { mode: 0o600 });
    await chmod(real, 0o600);
    const link = join(dir, 'fyd.env');
    await symlink(real, link);
    const ran = Bun.spawn(['/bin/sh', wrapper, envProgram, link, envProgram], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(ran.stdout).text(),
      new Response(ran.stderr).text(),
      ran.exited,
    ]);
    await rm(dir, { recursive: true });
    expect(code).toBe(78);
    expect(out).toBe('');
    expect(err).toContain('a link');
  });

  test.each([0o644, 0o640, 0o660, 0o400, 0o700])(
    'fails closed (78) when the env file is mode %o, not exactly 0600',
    async mode => {
      const dir = await mkdtemp(join(tmpdir(), 'fyd-exec-'));
      const file = join(dir, 'fyd.env');
      await writeFile(file, 'X=1\n', { mode });
      await chmod(file, mode);
      const ran = Bun.spawn(['/bin/sh', wrapper, envProgram, file, envProgram], {
        env: { PATH: '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(ran.stdout).text(),
        new Response(ran.stderr).text(),
        ran.exited,
      ]);
      await rm(dir, { recursive: true });
      expect(code).toBe(78);
      expect(out).toBe('');
      expect(err).toContain('0600');
    },
  );

  test('fails closed (78) when the program is not an executable file, instead of a shell exec error', async () => {
    const r = await runWrapper('X=1\n', {}, ['/nonexistent/fyd']);
    await rm(r.dir, { recursive: true });
    expect(r.code).toBe(78);
  });

  test('fails closed (78) when the env file is a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fyd-exec-'));
    const ran = Bun.spawn(['/bin/sh', wrapper, envProgram, dir, envProgram], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await ran.exited).toBe(78);
    await rm(dir, { recursive: true });
  });

  test('fails closed on a program path holding "="', async () => {
    const r = await runWrapper('X=1\n', {}, ['/tmp/a=b/fyd']);
    await rm(r.dir, { recursive: true });
    expect(r.code).toBe(78);
  });
});
