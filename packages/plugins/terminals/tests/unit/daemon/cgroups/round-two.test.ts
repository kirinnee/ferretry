import {
  BROWSER_SLICE,
  escapeUnitPart,
  eventsGrowth,
  ferretSliceName,
  parseCapFile,
  parseCpuMax,
  parseMemoryEvents,
  parseWeightFile,
  sameCap,
  sessionOfSlice,
  sliceCgroupPath,
} from '../../../../daemon/lib/cgroups/index.ts';
import { expect, test } from 'bun:test';
import { GIBIBYTE } from '../../../../daemon/lib/protocol/limits.ts';
import { TmuxTerminalRuntime } from '../../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { CgroupLaunchPlanner } from '../../../../daemon/lib/cgroups/launch.ts';
import { EnforcementRuntime } from '../../../../daemon/lib/cgroups/runtime.ts';
import { buildLimitsView } from '../../../../daemon/lib/cgroups/view.ts';
import { FleetMemoryWatcher } from '../../../../daemon/lib/cgroups/watch.ts';
import { type TerminalSubsystem, terminalRoutes } from '../../../../daemon/lib/runtime/mounts/terminals.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/types.ts';
import { request } from '../api/support.ts';

const host = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 57 * GIBIBYTE,
  ceilingSource: 'user slice',
  swapBytes: 0,
};
const zero = { high: 0, max: 0, oom: 0, oomKill: 0 };
const live = { throttled: [], fleetSlowed: false, killed: [], overBudget: [] };
const ok = { code: 0, stdout: '', stderr: '' };

function planner() {
  let n = 0;
  return new CgroupLaunchPlanner({
    limits: async () => ({}),
    host,
    commands: { execute: async () => ok },
    sessions: { facts: async id => (id === 'warden-session' ? { label: WARDEN_LABEL } : {}) },
    enforcement: new EnforcementRuntime(
      async () => ({ kind: 'cgroups', ionice: true }),
      () => 1_000_000,
    ),
    nonce: () => `nonce${++n}`,
  });
}

test('regression: a terminal in the Warden session keeps the ordinary opener’s caps', async () => {
  const commands: string[][] = [];
  const runtime = new TmuxTerminalRuntime(
    {
      execute: async argv => {
        commands.push([...argv]);
        return ok;
      },
    },
    () => 1_000_000,
    { shell: async () => '/bin/zsh' },
    planner(),
  );
  let recorded: Parameters<TmuxTerminalRuntime['create']>[0]['openedBy'];
  const subsystem = {
    create: async (
      sessionId: string,
      _input: unknown,
      openedBy: Parameters<TmuxTerminalRuntime['create']>[0]['openedBy'],
    ) => {
      recorded = openedBy;
      const record = await runtime.create({
        ownerId: sessionId,
        id: '0123456789ab',
        title: 'dev',
        cwd: '/tmp',
        size: { cols: 100, rows: 30 },
        openedBy,
      });
      return { id: record.id, sessionId };
    },
  } as unknown as TerminalSubsystem;
  const credential = `fys_${'a'.repeat(43)}`; // Synthetic, never a real credential.
  const dispatcher = new ApiDispatcher(
    new ApiRouter(terminalRoutes(subsystem)),
    {
      admin: 'synthetic-admin',
      sessions: { resolve: async presented => (presented === credential ? { sessionId: 'agent-session' } : undefined) },
    },
    {
      decide: () => ({ allowed: true, refusal: 'granted' }),
      explain: () => '',
      governance: () => ({ governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) }),
    },
  );
  const answer = await dispatcher.dispatch(
    request({
      method: 'POST',
      path: '/v1/sessions/warden-session/terminals',
      loopback: true,
      privilegedLoopback: true,
      headers: { authorization: `Bearer ${credential}` },
      body: '',
    }),
  );
  expect(answer.status).toBe(201);
  expect(recorded).toEqual({ by: 'agent', sessionId: 'agent-session' });
  const argv = commands[0] as string[];
  const words = argv.slice(argv.indexOf('30') + 1, argv.indexOf(';'));
  expect(words[0]).toBe('systemd-run');
  expect(words).toContain('--slice=ferretry_fleet-agent\\x2dsession.slice');
});

test('regression: two terminals share the same per-ferret slice', async () => {
  const p = planner();
  const a = await p.command('agent-session', ['/bin/zsh', '-l'], { terminal: true });
  const b = await p.command('agent-session', ['/bin/zsh', '-l'], { terminal: true });
  expect(a.find(x => x.startsWith('--unit='))).not.toEqual(b.find(x => x.startsWith('--unit=')));
  for (const argv of [a, b]) expect(argv.some(x => x.startsWith('--property=MemoryMax='))).toBe(false);
  expect(a.find(x => x.startsWith('--slice='))).toBe('--slice=ferretry_fleet-agent\\x2dsession.slice');
});

test('regression: one child high event slows only that ferret', async () => {
  let high = 0;
  const notes: unknown[] = [];
  const watcher = new FleetMemoryWatcher({
    fleet: {
      read: async () => ({
        events: { ...zero, high },
        scopes: [
          { scope: 'ferretry-agent-s1-n1.scope', events: { ...zero, high }, currentBytes: 1, highBytes: 2 },
          { scope: 'ferretry-agent-s2-n2.scope', events: zero, currentBytes: 1, highBytes: 2 },
        ],
      }),
      largest: async () => [],
    },
    memory: { sessions: async () => [], total: async () => 0 },
    notes: {
      note: async (...args) => {
        notes.push(args);
      },
      callsign: async id => id,
    },
    now: () => 1_000_000,
    iso: ms => new Date(ms).toISOString(),
  });
  await watcher.tickLinux();
  high = 1; // memory.events includes its descendants, memory.events.local would still be zero.
  await watcher.tickLinux();
  const state = await watcher.state();
  expect(state.fleetSlowed).toBe(false);
  expect(notes).not.toContainEqual(['s2', 'memory_throttled', { shared: true }]);
});

test('regression: one ferret with two pressured scopes counts once', async () => {
  let high = 0;
  const watcher = new FleetMemoryWatcher({
    fleet: {
      read: async () => ({
        events: { ...zero, high: 2 * high },
        scopes: [
          { scope: 'ferretry-agent-s1-n1.scope', events: { ...zero, high } },
          { scope: 'ferretry-agent-s1-tn2.scope', events: { ...zero, high } },
        ],
      }),
      largest: async () => [],
    },
    memory: { sessions: async () => [], total: async () => 0 },
    notes: { note: async () => {}, callsign: async id => id },
    now: () => 1_000_000,
    iso: ms => new Date(ms).toISOString(),
  });
  await watcher.tickLinux();
  high = 1;
  await watcher.tickLinux();
  expect((await watcher.state()).throttled.map(x => x.sessionId)).toEqual(['s1']);
});

test('regression: unreadable applied caps remain unknown', () => {
  const view = buildLimitsView({
    config: { fleet: { memoryMax: '30G' } },
    host,
    enforcement: { kind: 'cgroups', ionice: true },
    disk: { scheduler: 'none' },
    services: { daemon: 1000, voiceState: 'not-running' as const },
    live: { ...live, applied: { fleet: {}, scopes: [] } },
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: x => x,
  });
  expect(view.enforcement).toBe('cgroups');
  expect(view.lines[0]).toContain('memory unknown soft / unknown hard');
  expect(view.fleet.memoryMaxBytes).toBeUndefined();
  expect(view.lines.some(x => x.includes('not yet applied'))).toBe(false);
});

test('regression: a 4096-to-32 task tightening reports the earlier running cap', () => {
  const applied = {
    memoryHigh: Math.floor(host.memoryCeilingBytes * 0.25),
    memoryMax: Math.floor(host.memoryCeilingBytes * 0.3),
    tasksMax: 4096,
  };
  const view = buildLimitsView({
    config: { perFerret: { tasksMax: 32 } },
    host,
    enforcement: { kind: 'cgroups', ionice: true },
    disk: { scheduler: 'none' },
    services: { daemon: 1000, voiceState: 'not-running' as const },
    live: { ...live, applied: { fleet: {}, scopes: [applied] } },
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: x => x,
  });
  expect(view.perFerret.tasksMax).toBe(4096);
  expect(view.lines.some(x => x.includes('running ferret keeps'))).toBe(true);
});

test('regression: a Mac wrapper failure reports no priority enforcement', async () => {
  const mac = { ...host, platform: 'darwin', unifiedHierarchy: false };
  const enforcement = new EnforcementRuntime(
    async () => ({ kind: 'priority', wrapper: 'taskpolicy' }),
    () => 1_000_000,
  );
  const p = new CgroupLaunchPlanner({
    limits: async () => ({}),
    host: mac,
    commands: { execute: async () => ({ code: 1, stdout: '', stderr: 'taskpolicy: not permitted' }) },
    sessions: { facts: async () => ({}) },
    enforcement,
    nonce: () => 'nonce',
  });
  expect(await p.command('s1', ['claude'])).toEqual(['claude']);
  const view = buildLimitsView({
    config: {},
    host: mac,
    enforcement: enforcement.last(),
    launchFailure: enforcement.lastLaunchFailure(),
    disk: {},
    services: { daemon: 1000, voiceState: 'not-running' as const },
    live,
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: x => x,
  });
  expect(view.enforcement).toBe('none');
  expect(view.notEnforcedBecause).toContain('taskpolicy: not permitted');
  expect(view.lines[0]).toContain('limits not enforced:');
});

test('regression: shared Chrome and worker get bounded scopes below the fleet', async () => {
  const p = planner();
  for (const command of [
    ['chrome', '--remote-debugging-pipe'],
    ['node', '/worker.js', 'pipe'],
  ]) {
    const argv = await p.browserCommand(command);
    expect(argv[0]).toBe('systemd-run');
    expect(argv).toContain('--slice=ferretry_fleet-browser.slice');
    expect(argv.slice(-command.length)).toEqual(command);
  }
});

test('per-ferret slices escape session dashes without creating extra ancestors', () => {
  const slice = ferretSliceName('sid-one');
  expect(slice).toBe('ferretry_fleet-sid\\x2done.slice');
  expect(sliceCgroupPath(slice)).toEqual(['ferretry_fleet.slice', slice]);
  expect(sessionOfSlice(slice)).toBe('sid-one');
  expect(sessionOfSlice(ferretSliceName('.ü /'))).toBe('.ü /');
  expect(escapeUnitPart('a_b:2.')).toBe('a_b:2.');
  for (const invalid of [
    BROWSER_SLICE,
    'other.slice',
    'ferretry_fleet-.slice',
    'ferretry_fleet-\\xyz.slice',
    'ferretry_fleet-s1.scope',
  ])
    expect(sessionOfSlice(invalid)).toBeUndefined();
});

test('caps parsers preserve unknown, unlimited, exact task counts and measured CPU quota', () => {
  expect(parseMemoryEvents('low 0\nignored nonsense')).toEqual(zero);
  expect(parseMemoryEvents('high 2\nmax 3\noom 4\noom_kill 5')).toEqual({ high: 2, max: 3, oom: 4, oomKill: 5 });
  expect(parseMemoryEvents('not counters')).toBeUndefined();
  expect(eventsGrowth(undefined, zero)).toEqual(zero);
  expect(eventsGrowth({ high: 4, max: 3, oom: 2, oomKill: 1 }, zero)).toEqual(zero);
  expect(parseCapFile('max\n')).toBeNull();
  expect(parseCapFile('9223372036854771712')).toBeNull();
  expect(parseCapFile(String(2 ** 52))).toBeNull();
  expect(parseCapFile('32')).toBe(32);
  expect(parseCapFile('unknown')).toBeUndefined();
  expect(parseWeightFile('200\n')).toBe(200);
  expect(parseWeightFile('0')).toBeUndefined();
  expect(parseWeightFile('unknown')).toBeUndefined();
  expect(parseCpuMax('max 100000', 32)).toBeNull();
  expect(parseCpuMax('800000 100000', 32)).toBe(25);
  expect(parseCpuMax('100 0', 32)).toBeUndefined();
  expect(parseCpuMax('unknown', 32)).toBeUndefined();
  expect(sameCap(undefined, 10)).toBe(false);
  expect(sameCap(null, null)).toBe(true);
  expect(sameCap(null, 1)).toBe(false);
  expect(sameCap(8191, 4096)).toBe(true);
  expect(sameCap(8192, 4096)).toBe(false);
});

test('fleet-wide pressure uses local events when present and ignores hierarchical child growth', async () => {
  for (const local of [true, false]) {
    let childHigh = 0,
      fleetHigh = 0;
    const notes: unknown[] = [];
    const watcher = new FleetMemoryWatcher({
      fleet: {
        read: async () => ({
          events: { ...zero, high: childHigh + fleetHigh },
          ...(local ? { localEvents: { ...zero, high: fleetHigh } } : {}),
          scopes: [
            { scope: ferretSliceName('s1'), events: { ...zero, high: childHigh } },
            { scope: ferretSliceName('s2'), events: zero },
          ],
        }),
        largest: async () => [],
      },
      memory: { sessions: async () => [], total: async () => 0 },
      notes: {
        note: async (...args) => {
          notes.push(args);
        },
        callsign: async id => id,
      },
      now: () => 1_000_000,
      iso: ms => new Date(ms).toISOString(),
    });
    await watcher.tickLinux();
    childHigh = 1;
    await watcher.tickLinux();
    expect((await watcher.state()).fleetSlowed).toBe(false);
    expect(notes).not.toContainEqual(['s2', 'memory_throttled', { shared: true }]);
    fleetHigh = 1;
    await watcher.tickLinux();
    expect((await watcher.state()).fleetSlowed).toBe(true);
    expect(notes).toContainEqual(['s2', 'memory_throttled', { shared: true }]);
  }
});

test('CPU status uses measured values while keeping future defaults separate', () => {
  const view = buildLimitsView({
    config: { fleet: { cpuPercent: 50 }, perFerret: { cpuPercent: 25 } },
    host,
    enforcement: { kind: 'cgroups', ionice: true },
    disk: {},
    services: { daemon: 1000, voiceState: 'not-running' as const },
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: x => x,
    live: {
      ...live,
      applied: {
        fleet: { cpuWeight: 70, cpuPercent: 10, tasksMax: 16384 },
        scopes: [{ cpuWeight: 200, cpuPercent: null }],
      },
    },
  });
  expect(view.fleet.cpuWeight).toBe(70);
  expect(view.fleet.cpuPercent).toBe(10);
  expect(view.perFerret.cpuWeight).toBe(200);
  expect(view.perFerret.cpuPercent).toBeNull();
  expect(view.perFerret.interactiveCpuWeight).toBeUndefined();
  expect(view.configured?.fleet.cpuPercent).toBe(50);
  expect(view.configured?.perFerret.cpuPercent).toBe(25);
  expect(view.perFerret.memoryMaxBytes).toBeUndefined();
  expect(view.lines.join('\n')).toContain('unknown');
});

test('fleet task counts compare exactly while byte caps still allow page rounding', () => {
  const view = buildLimitsView({
    config: { fleet: { tasksMax: 32 } },
    host,
    enforcement: { kind: 'cgroups', ionice: false },
    disk: {},
    services: { daemon: 1000, voiceState: 'not-running' as const },
    file: 'limits.yaml',
    uid: 1000,
    warnings: [],
    clock: x => x,
    live: {
      ...live,
      applied: {
        fleet: {
          memoryHigh: host.memoryCeilingBytes - 4 * GIBIBYTE + 1,
          memoryMax: host.memoryCeilingBytes - 2 * GIBIBYTE + 1,
          tasksMax: 4096,
        },
        scopes: [],
      },
    },
  });
  expect(view.fleet.tasksMax).toBe(4096);
  expect(view.lines.join('\n')).toContain('up to 32 processes');
});

test('harness and terminals share one slice and one set of caps', async () => {
  const ran: (readonly string[])[] = [];
  let nonce = 0;
  const p = new CgroupLaunchPlanner({
    limits: async () => ({ perFerret: { memoryMax: '1G', tasksMax: 32 } }),
    host,
    commands: {
      execute: async argv => {
        ran.push(argv);
        return ok;
      },
    },
    sessions: { facts: async () => ({}) },
    enforcement: new EnforcementRuntime(
      async () => ({ kind: 'cgroups', ionice: false }),
      () => 1,
    ),
    nonce: () => `n${++nonce}`,
  });
  const harness = await p.command('s-1', ['claude']);
  const terminal = await p.command('s-1', ['zsh'], { terminal: true });
  for (const argv of [harness, terminal]) {
    expect(argv).toContain(`--slice=${ferretSliceName('s-1')}`);
    expect(argv.some(word => word.startsWith('--property=MemoryMax='))).toBe(false);
  }
  expect(ran.filter(argv => argv[4] === ferretSliceName('s-1'))).toHaveLength(2);
  expect(ran[1]).toContain(`MemoryMax=${GIBIBYTE}`);
  expect(ran[1]).toContain('TasksMax=32');
});

test('browser scope refusal warns and falls back without a false enforcement claim', async () => {
  const warnings: string[] = [];
  const enforcement = new EnforcementRuntime(
    async () => ({ kind: 'cgroups', ionice: false }),
    () => 1,
  );
  const p = new CgroupLaunchPlanner({
    limits: async () => ({}),
    host,
    sessions: { facts: async () => ({}) },
    enforcement,
    nonce: () => 'n1',
    warn: message => warnings.push(message),
    commands: { execute: async () => ({ code: 1, stdout: '', stderr: 'refused' }) },
  });
  expect(await p.browserCommand(['chrome'])).toEqual(['chrome']);
  expect(enforcement.lastLaunchFailure()).toBe('refused');
  expect(warnings[0]).toContain('agent browser without ferret limits');
});

test('macOS spawn failures (including a rejected proof) start bare and report no priority', async () => {
  const mac = { ...host, platform: 'darwin', unifiedHierarchy: false };
  const enforcement = new EnforcementRuntime(
    async () => ({ kind: 'priority', wrapper: 'taskpolicy' }),
    () => 1_000_000,
  );
  const p = new CgroupLaunchPlanner({
    limits: async () => ({ enabled: true }),
    host: mac,
    sessions: { facts: async () => ({}) },
    enforcement,
    nonce: () => 'n1',
    commands: {
      execute: async () => {
        throw new Error('spawn refused');
      },
    },
  });
  expect(await p.command('s1', ['claude'])).toEqual(['claude']);
  expect(enforcement.lastLaunchFailure()).toBe('spawn refused');
});

test('only the Warden opener itself can exempt a terminal, even if opener facts are unreadable', async () => {
  for (const facts of [undefined, { parent: 'warden-session' }, { wardenLineage: true }, { label: WARDEN_LABEL }]) {
    const p = new CgroupLaunchPlanner({
      limits: async () => ({}),
      host,
      commands: { execute: async () => ok },
      sessions: { facts: async id => (id === 'warden-session' ? { label: WARDEN_LABEL } : facts) },
      enforcement: new EnforcementRuntime(
        async () => ({ kind: 'cgroups', ionice: false }),
        () => 1,
      ),
      nonce: () => 'n1',
    });
    const argv = await p.command('opener', ['zsh'], { terminal: true });
    expect(argv[0]).toBe(facts?.label === WARDEN_LABEL ? 'zsh' : 'systemd-run');
  }
});

test('a later terminal high event does not repeat its already-slowed ferret’s note', async () => {
  let first = 0,
    second = 0,
    now = 1_000_000;
  const notes: unknown[] = [];
  const watcher = new FleetMemoryWatcher({
    fleet: {
      read: async () => ({
        events: { ...zero, high: first + second },
        localEvents: zero,
        scopes: [
          { scope: 'ferretry-agent-s1-h.scope', events: { ...zero, high: first } },
          { scope: 'ferretry-agent-s1-t.scope', events: { ...zero, high: second } },
        ],
      }),
      largest: async () => [],
    },
    memory: { sessions: async () => [], total: async () => 0 },
    notes: {
      note: async (...args) => {
        notes.push(args);
      },
      callsign: async () => undefined,
    },
    now: () => now,
    iso: ms => new Date(ms).toISOString(),
  });
  await watcher.tickLinux();
  first = 1;
  await watcher.tickLinux();
  now += 30_000;
  second = 1;
  await watcher.tickLinux();
  expect(notes).toHaveLength(1);
  expect((await watcher.state()).throttled).toEqual([{ sessionId: 's1' }]);
  expect((await watcher.state()).applied?.scopes).toHaveLength(1);
});

test('running normal and interactive CPU weights match their own defaults', () => {
  for (const weight of [100, 200, 50]) {
    const view = buildLimitsView({
      config: {},
      host,
      enforcement: { kind: 'cgroups', ionice: false },
      disk: {},
      services: { daemon: 1000, voiceState: 'not-running' as const },
      file: 'limits.yaml',
      uid: 1000,
      warnings: [],
      clock: x => x,
      live: { ...live, applied: { fleet: {}, scopes: [{ cpuWeight: weight, cpuPercent: null }] } },
    });
    expect(view.lines.some(line => line.includes('running ferret keeps'))).toBe(weight === 50);
  }
});

test('shared browser child events cannot implicate ferrets when the local fleet file is unavailable', async () => {
  let high = 0,
    kills = 0;
  const watcher = new FleetMemoryWatcher({
    fleet: {
      read: async () => ({
        events: { ...zero, high, oomKill: kills },
        browserEvents: { ...zero, high, oomKill: kills },
        scopes: [{ scope: ferretSliceName('s1'), events: zero }],
      }),
      largest: async () => [],
    },
    memory: { sessions: async () => [], total: async () => 0 },
    notes: { note: async () => undefined, callsign: async () => undefined },
    now: () => 1,
    iso: ms => new Date(ms).toISOString(),
  });
  await watcher.tickLinux();
  high = 1;
  kills = 1;
  await watcher.tickLinux();
  expect((await watcher.state()).fleetSlowed).toBe(false);
  expect((await watcher.state()).killed).toEqual([]);
});
