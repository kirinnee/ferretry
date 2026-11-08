/**
 * The kernel-owned V rows of docs/design/rebuild-parity.tsv that are `fy daemon …` verbs, each named by its id. They
 * live in the shell's own tests: a kernel test may not import the shell (context-imports).
 */
import { describe, expect, it } from 'bun:test';
import type { DaemonController, DaemonControlReads } from '../../../src/lib/daemon/controller.ts';
import { runFy } from '../../../src/lib/run.ts';
import { fakeWorld } from '../fakes.ts';

type Call = readonly [method: string, options: unknown];

function daemonWorld(probe: 'up' | 'down' = 'up') {
  const made = fakeWorld({
    probe:
      probe === 'up'
        ? { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } }
        : { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' },
  });
  const calls: Call[] = [];
  const record = (method: string) => async (options?: unknown) => {
    calls.push([method, options]);
  };
  const controller = {
    install: record('install'),
    uninstall: record('uninstall'),
    stop: record('stop'),
    restart: record('restart'),
    which: record('which'),
    logs: record('logs'),
    reset: record('reset'),
  } as unknown as DaemonController;
  const world = {
    ...made.world,
    daemon: (_reads: DaemonControlReads) => ({ controller, exitCode: () => 0 }),
  };
  return { ...made, world, calls };
}

const run = async (argv: string[], probe: 'up' | 'down' = 'up') => {
  const built = daemonWorld(probe);
  const code = await runFy(argv, built.world);
  return { ...built, code, out: built.io.stdout(), err: built.io.stderr() };
};

describe('fy daemon', () => {
  it('V-0223 bare fy daemon names the daemon verbs it manages and exits as a usage error', async () => {
    const result = await run(['daemon']);
    expect(result.code).toBe(2);
    for (const verb of ['status', 'start', 'stop', 'restart', 'install', 'uninstall', 'logs', 'which', 'reset'])
      expect(result.err).toContain(`fy daemon ${verb}`);
  });

  it.each([
    ['V-0233', 'install'],
    ['V-0249', 'uninstall'],
    ['V-0244', 'stop'],
  ] as const)('%s fy daemon %s runs the controller verb and exits with its code', async (_id, verb) => {
    const result = await run(['daemon', verb]);
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call[0])).toEqual([verb]);
  });

  it('V-0242 fy daemon start launches a daemon that is down and exits 0, and says so when it is already up', async () => {
    const down = await run(['daemon', 'start'], 'down');
    expect(down.code).toBe(0);
    expect(down.out).toContain('the daemon is running at http://127.0.0.1:7431');
    const up = await run(['daemon', 'start']);
    expect(up.code).toBe(0);
    expect(up.out).toContain('the daemon is already running');
  });

  it('V-0242 fy daemon start exits non-zero with the reason when the daemon does not come up', async () => {
    const made = fakeWorld({
      probe: { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' },
      launch: { started: false, why: 'the daemon did not serve in time' },
    });
    expect(await runFy(['daemon', 'start'], made.world)).toBe(1);
    expect(made.io.stderr()).toContain('the daemon did not serve in time');
  });

  it('V-0237 fy daemon restart --when-idle waits for idle; without the flag the restart goes ahead', async () => {
    const waiting = await run(['daemon', 'restart', '--when-idle']);
    expect(waiting.calls).toEqual([['restart', { whenIdle: true }]]);
    const plain = await run(['daemon', 'restart']);
    expect(plain.calls).toEqual([['restart', {}]]);
  });

  it('V-0234 fy daemon logs prints the log, and -f / --follow keeps streaming', async () => {
    expect((await run(['daemon', 'logs'])).calls).toEqual([['logs', { follow: false }]]);
    expect((await run(['daemon', 'logs', '--follow'])).calls).toEqual([['logs', { follow: true }]]);
    expect((await run(['daemon', 'logs', '-f'])).calls).toEqual([['logs', { follow: true }]]);
  });

  it('V-0251 fy daemon which shows the identities, and --json asks for the machine-readable form', async () => {
    expect((await run(['daemon', 'which'])).calls).toEqual([['which', { json: false }]]);
    expect((await run(['daemon', 'which', '--json'])).calls).toEqual([['which', { json: true }]]);
  });

  it('V-0236 fy daemon reset takes -y / --yes to skip the typed confirmation', async () => {
    expect((await run(['daemon', 'reset'])).calls).toEqual([['reset', { yes: false }]]);
    expect((await run(['daemon', 'reset', '--yes'])).calls).toEqual([['reset', { yes: true }]]);
    expect((await run(['daemon', 'reset', '-y'])).calls).toEqual([['reset', { yes: true }]]);
  });

  it('V-0243 fy daemon status reports whether the daemon serves; exits non-zero when it does not', async () => {
    const up = await run(['daemon', 'status']);
    expect(up.code).toBe(0);
    expect(up.out).toContain('daemon   running at http://127.0.0.1:7431');
    expect(up.out).toContain('version  5.0.0');
    const down = await run(['daemon', 'status'], 'down');
    expect(down.code).toBe(1);
    expect(down.err).toContain('not running at http://127.0.0.1:7431');
  });

  it('V-0243 fy daemon status --json prints one machine-readable object, with the same exit codes', async () => {
    const up = await run(['daemon', 'status', '--json']);
    expect(up.code).toBe(0);
    expect(JSON.parse(up.out)).toEqual({
      running: true,
      baseUrl: 'http://127.0.0.1:7431',
      version: '5.0.0',
      protocol: 1,
    });
    const down = await run(['daemon', 'status', '--json'], 'down');
    expect(down.code).toBe(1);
    expect(JSON.parse(down.out)).toEqual({
      running: false,
      baseUrl: 'http://127.0.0.1:7431',
      why: 'connection refused',
    });
  });
});
