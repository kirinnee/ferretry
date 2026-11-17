/**
 * The kernel-owned V rows of docs/design/rebuild-parity.tsv that are `fy daemon …` verbs, each named by its id. They
 * live in the shell's own tests: a kernel test may not import the shell (context-imports).
 */
import { describe, expect, it } from 'bun:test';
import type { DaemonController, DaemonControlReads } from '../../../src/lib/daemon/controller.ts';
import { runFy } from '../../../src/lib/run.ts';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import { fakeWorld, inventoryOf, registryOf, skeletonEntry } from '../fakes.ts';

type Call = readonly [method: string, options: unknown];

function daemonWorld(probe: 'up' | 'down' = 'up', exitCode = 0) {
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
    daemon: (_reads: DaemonControlReads) => ({ controller, exitCode: () => exitCode }),
  };
  return { ...made, world, calls };
}

const run = async (argv: string[], probe: 'up' | 'down' = 'up', exitCode = 0) => {
  const built = daemonWorld(probe, exitCode);
  const code = await runFy(argv, built.world);
  return { ...built, code, out: built.io.stdout(), err: built.io.stderr() };
};

/** Connections as a test daemon has it: the one read `fy daemon status` makes for its Tunnel line. */
const connectionsManifest = definePlugin({
  id: 'connections',
  title: 'Connections',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    routes: [
      route('GET /v1/tunnel', { minimum: 'operator', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } }),
    ],
  },
});

/** Terminals as a test daemon has it: the one read `fy daemon status` makes for its Limits block. */
const terminalsManifest = definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    routes: [
      route('GET /v1/cgroups/config', {
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'test' },
        guard: { none: 'test' },
      }),
    ],
  },
});

describe('fy daemon', () => {
  it('V-0223 bare fy daemon names the daemon verbs it manages and exits as a usage error', async () => {
    const result = await run(['daemon']);
    expect(result.code).toBe(2);
    for (const verb of ['status', 'start', 'stop', 'restart', 'install', 'uninstall', 'logs', 'which', 'reset'])
      expect(result.err).toContain(`fy daemon ${verb}`);
  });

  async function runsTheControllerVerb(verb: 'install' | 'uninstall' | 'stop') {
    const result = await run(['daemon', verb]);
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call[0])).toEqual([verb]);
    // The verb's own failure is the command's exit code, not a flat zero.
    expect((await run(['daemon', verb], 'up', 7)).code).toBe(7);
  }
  it('V-0233 fy daemon install runs the controller verb and exits with its code', () =>
    runsTheControllerVerb('install'));
  it('V-0249 fy daemon uninstall runs the controller verb and exits with its code', () =>
    runsTheControllerVerb('uninstall'));
  it('V-0244 fy daemon stop runs the controller verb and exits with its code', () => runsTheControllerVerb('stop'));

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

  it('K3 fy daemon status adds the daemon’s own Limits words, and nothing when they cannot be read', async () => {
    const withTerminals = fakeWorld({
      registry: registryOf(skeletonEntry(terminalsManifest, 'h-terminals')),
      inventory: inventoryOf({ id: 'terminals', contract: 'h-terminals' }),
    });
    withTerminals.transport.replies.push({
      status: 200,
      body: {
        lines: ['Ferrets are limited: 12 GiB for all of them, 4 GiB kept for the daemon.', 'Disk priority is lowered.'],
        warnings: ['A cap above the daemon holds this user to 8 GiB.'],
      },
    });
    expect(await runFy(['daemon', 'status'], withTerminals.world)).toBe(0);
    expect(withTerminals.transport.sent.map(sent => `${sent.method} ${sent.path}`)).toEqual(['GET /v1/cgroups/config']);
    expect(withTerminals.io.stdout()).toContain(
      [
        'limits   Ferrets are limited: 12 GiB for all of them, 4 GiB kept for the daemon.',
        '         Disk priority is lowered.',
        '         warning: A cap above the daemon holds this user to 8 GiB.',
      ].join('\n'),
    );
    // A daemon that cannot answer the read (an older one, Terminals off) still reports itself: no line, the same exit.
    const without = await run(['daemon', 'status']);
    expect(without.code).toBe(0);
    expect(without.out).not.toContain('limits');
    const broken = fakeWorld({
      registry: registryOf(skeletonEntry(terminalsManifest, 'h-terminals')),
      inventory: inventoryOf({ id: 'terminals', contract: 'h-terminals' }),
    });
    broken.transport.replies.push({ status: 200, body: { nonsense: true } });
    expect(await runFy(['daemon', 'status'], broken.world)).toBe(0);
    expect(broken.io.stdout()).not.toContain('limits');
  });

  it('L23 fy daemon status says the tunnel while the daemon serves, in --json too, and is silent when it cannot be read', async () => {
    const sentence = 'The tunnel is up at https://example.invalid.';
    const reply = { enabled: true, explicit: true, state: 'up', tunnelUrl: 'https://example.invalid', sentence };
    const make = () => {
      const made = fakeWorld({
        registry: registryOf(skeletonEntry(connectionsManifest, 'h-connections')),
        inventory: inventoryOf({ id: 'connections', contract: 'h-connections' }),
      });
      made.transport.replies.push({ status: 200, body: reply });
      return made;
    };
    const text = make();
    expect(await runFy(['daemon', 'status'], text.world)).toBe(0);
    expect(text.transport.sent.map(sent => `${sent.method} ${sent.path}`)).toEqual(['GET /v1/tunnel']);
    expect(text.io.stdout()).toContain(`Tunnel: ${sentence}`);
    expect(text.io.stdout()).toContain('not reported in 5.0: liveness, firewall');
    const json = make();
    expect(await runFy(['daemon', 'status', '--json'], json.world)).toBe(0);
    expect(JSON.parse(json.io.stdout())).toMatchObject({
      tunnel: { state: 'up', sentence },
      notReported: ['liveness', 'firewall'],
    });
    // Connections off or an older daemon: no line, the same exit, and the tunnel is named as not reported.
    const without = await run(['daemon', 'status', '--json']);
    expect(without.code).toBe(0);
    expect(JSON.parse(without.out)).not.toHaveProperty('tunnel');
    expect(JSON.parse(without.out).notReported).toContain('tunnel');
    // Down: nothing is asked of a daemon that is not there.
    const down = await run(['daemon', 'status', '--json'], 'down');
    expect(JSON.parse(down.out)).not.toHaveProperty('tunnel');
  });

  it('V-0243 fy daemon status --json prints one machine-readable object, with the same exit codes', async () => {
    const up = await run(['daemon', 'status', '--json']);
    expect(up.code).toBe(0);
    // 5.0's keys, kept; today's supervisor keys join them (daemon-status-supervisor.test.ts pins those). This world has no
    // daemon-control adapters, so the supervisor is named unread rather than guessed.
    expect(JSON.parse(up.out)).toMatchObject({
      running: true,
      baseUrl: 'http://127.0.0.1:7431',
      version: '5.0.0',
      protocol: 1,
      reachability: 'serving',
      orphan: false,
      supervisor: { manager: 'unknown', state: 'not-reported' },
    });
    const down = await run(['daemon', 'status', '--json'], 'down');
    expect(down.code).toBe(1);
    expect(JSON.parse(down.out)).toMatchObject({
      running: false,
      baseUrl: 'http://127.0.0.1:7431',
      why: 'connection refused',
      reachability: 'stopped',
    });
  });
});
