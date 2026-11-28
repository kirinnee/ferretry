/**
 * E-276 0a: what an ended runtime leaves behind — the Codex app-server supervisor's decisions (`CodexAppServerSupervisor`,
 * `codexRuntimeHome`, `runtimeHomeId`, `parseCodexPidFile`) and the reaction that calls it when a ferret stops
 * (`RuntimeEndSupervision`), including the Claude NO-OP: an ended Claude ferret leaves nothing for Runtimes to stop.
 *
 * Everything is a fake port: a fleet root that answers from an in-memory map of pid files, a process table that is an array, a
 * Ferrets port that is a map. No process is looked at and nothing is signalled. Each case is written down as the decision AND
 * every call the decision made (what was read, which pids were asked about, how long it waited, who was signalled), so a move of
 * one harness's supervision to its plugin has to leave the calls identical, not just the verdict.
 */
import { describe, it } from 'bun:test';
import type { FencedPath, OwnFolder, ProcessesPort, RootHandle } from '@ferretry/kernel/contract';
import {
  type CodexAppServerHost,
  CodexAppServerSupervisor,
  type CodexRuntimeAccount,
  codexRuntimeHome,
  parseCodexPidFile,
  runtimeHomeId,
} from '../../../../codex/daemon/lib/runtimes-kit/codex-runtime.ts';
import {
  type FerretChange,
  RuntimeEndSupervision,
} from '../../../../codex/daemon/lib/runtimes-kit/runtime-end-supervision.ts';
import { expectGolden } from './support/golden.ts';

const HOMES = '/fleet/homes';
const BIN = '/fleet/bin';
const HOME = `${HOMES}/codex-a`;

const codex = (name: string, home = `${HOMES}/${name}`): CodexRuntimeAccount => ({
  kind: 'codex',
  wrapper: `${BIN}/${name}`,
  home,
});
const PUBLISHED: readonly CodexRuntimeAccount[] = [
  codex('codex-a', HOME),
  codex('codex-trailing', `${HOMES}/codex-trailing/`),
  { kind: 'claude', wrapper: `${BIN}/claude-a`, home: `${HOMES}/claude-a` },
  codex('codex-outside', '/home/person/.codex'),
  codex('codex-climb', `${HOMES}/../escape`),
  codex('codex-dot', `${HOMES}/./codex-dot`),
  codex('codex-nested', `${HOME}/nested`),
];

interface Scenario {
  readonly wrapper: string;
  /** The pid files of the one runtime home, by name (a name not here is absent). */
  readonly pidFiles?: Readonly<Record<string, string>>;
  /** The pids the process table finds running from the home's app-server package. */
  readonly running?: readonly number[];
  /** What `usersOf('CODEX_HOME')` answers each time it is asked, in order (the last answer repeats); `undefined` = cannot be listed. */
  readonly users?: readonly (readonly number[] | undefined)[];
  /** Pids the kernel refuses to signal. */
  readonly refuse?: readonly number[];
  readonly accounts?: () => Promise<readonly CodexRuntimeAccount[]>;
  /** The root resolves nothing (the fleet folder cannot be opened). */
  readonly unreachable?: boolean;
}

const TWO_PIDS = {
  'app-server-daemon/daemon.pid': '{"pid":100,"processStartTime":"x"}',
  'app-server-daemon/daemon-updater.pid': '{"pid":101}',
};

/** Run one scenario over fake ports and write down the verdict and every call that led to it. */
async function decide(scenario: Scenario) {
  const calls: string[] = [];
  const answers = scenario.users ?? [[100, 101]];
  let asked = 0;
  const root = {
    resolve: (relative: string) => {
      calls.push(`resolve ${relative}`);
      return scenario.unreachable === true
        ? { ok: false, error: 'outside_root' }
        : { ok: true, value: `/fleet/${relative}` as FencedPath };
    },
    readText: async (path: FencedPath) => {
      calls.push(`readText ${path}`);
      const text = scenario.pidFiles?.[path.slice(`${HOME}/`.length)];
      if (text === undefined) throw new Error('not found');
      return text;
    },
  } as unknown as RootHandle;
  const processes: CodexAppServerHost['processes'] = {
    runsFrom: async (pid: number, under: OwnFolder) => {
      calls.push(`runsFrom ${String(pid)} ${under.path}`);
      return scenario.running?.includes(pid) ?? false;
    },
    usersOf: async (variable: string, home: OwnFolder) => {
      calls.push(`usersOf ${variable} ${home.path}`);
      const answer = answers[Math.min(asked++, answers.length - 1)];
      return answer;
    },
    terminate: async (pid: number, under: OwnFolder) => {
      calls.push(`terminate ${String(pid)} ${under.path}`);
      return scenario.refuse?.includes(pid) === true ? 'refused' : 'signalled';
    },
  } as unknown as Pick<ProcessesPort, 'runsFrom' | 'usersOf' | 'terminate'>;
  const supervisor = new CodexAppServerSupervisor({
    inventory: { accounts: scenario.accounts ?? (async () => PUBLISHED) },
    host: { fleet: root, processes },
    homesDirectory: HOMES,
    sleep: async milliseconds => {
      calls.push(`sleep ${String(milliseconds)}`);
    },
    attempts: 3,
    intervalMs: 50,
  });
  return { decision: await supervisor.afterSessionEnded(scenario.wrapper), calls };
}

const RUNNING = { wrapper: `${BIN}/codex-a`, pidFiles: TWO_PIDS, running: [100, 101] } as const;

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'stops the pair when only the daemon pair uses the home': RUNNING,
  'stops the pair when the own harness of the session is still exiting on the first looks': {
    ...RUNNING,
    users: [
      [100, 101, 7],
      [100, 101, 7],
      [100, 101],
    ],
  },
  'leaves it running while another process uses the home': { ...RUNNING, users: [[100, 101, 7]] },
  'leaves it running when the users of the home cannot be listed': { ...RUNNING, users: [undefined] },
  'stops only the pids the kernel signals': { ...RUNNING, refuse: [101] },
  'is undecided when the kernel signals none of them': { ...RUNNING, refuse: [100, 101] },
  'stops a pid that runs from the package even when only one pid file exists': {
    wrapper: `${BIN}/codex-a`,
    pidFiles: { 'app-server-daemon/daemon.pid': '{"pid":100}' },
    running: [100],
    users: [[100]],
  },
  'ignores a pid the kernel does not find running from the package (a reused pid)': {
    ...RUNNING,
    running: [101],
    users: [[101]],
  },
  'finds nothing running when no pid file exists': { wrapper: `${BIN}/codex-a`, running: [] },
  'finds nothing running when a pid file is not a pid': {
    wrapper: `${BIN}/codex-a`,
    pidFiles: {
      'app-server-daemon/daemon.pid': 'not json',
      'app-server-daemon/daemon-updater.pid': '{"pid":1}',
    },
    running: [1],
  },
  'finds nothing running when no recorded process runs from the package': { ...RUNNING, running: [] },
  'does nothing for a Claude runtime': { wrapper: `${BIN}/claude-a`, pidFiles: TWO_PIDS, running: [100, 101] },
  'does nothing for a wrapper nothing published': { wrapper: `${BIN}/never-published`, pidFiles: TWO_PIDS },
  'does nothing for a Codex runtime whose home is outside the fleet homes': {
    wrapper: `${BIN}/codex-outside`,
    pidFiles: TWO_PIDS,
    running: [100, 101],
  },
  'does nothing for a Codex home that climbs out of the fleet homes': {
    wrapper: `${BIN}/codex-climb`,
    pidFiles: TWO_PIDS,
  },
  'does nothing for a Codex home with a dot segment': { wrapper: `${BIN}/codex-dot`, pidFiles: TWO_PIDS },
  'does nothing for a Codex home nested below a runtime home': { wrapper: `${BIN}/codex-nested`, pidFiles: TWO_PIDS },
  'is undecided when the fleet root cannot be reached': { ...RUNNING, unreachable: true },
  'is undecided when the inventory cannot be read': {
    ...RUNNING,
    accounts: async () => {
      throw new Error('the manifest could not be read');
    },
  },
};

describe('codex app-server supervision goldens', () => {
  it('should decide each case over fake ports exactly as the base does, calls included', async () => {
    const decisions: Record<string, unknown> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) decisions[name] = await decide(scenario);
    expectGolden('supervision/codex-app-server', decisions);
  });

  it('should read pid files, runtime homes and home ids exactly as the base does', () => {
    expectGolden('supervision/codex-words', {
      pidFiles: Object.fromEntries(
        [
          '{"pid":100,"processStartTime":"x"}',
          '{"pid":1}',
          '{"pid":0}',
          '{"pid":2.5}',
          '{"pid":"100"}',
          '{"pid":9007199254740993}',
          '[]',
          'null',
          'nonsense',
          '',
        ].map(text => [text, parseCodexPidFile(text) ?? null]),
      ),
      runtimeHomes: Object.fromEntries(
        PUBLISHED.map(account => [account.wrapper, codexRuntimeHome(account.wrapper, PUBLISHED, `${HOMES}/`) ?? null]),
      ),
      byWrapperName: codexRuntimeHome('/elsewhere/bin/codex-a', PUBLISHED, HOMES) ?? null,
      homeIds: Object.fromEntries(
        [HOME, `${HOME}/`, `${HOME}/nested`, HOMES, `${HOMES}/`, `${HOMES}/..`, `${HOMES}/.`, '/elsewhere/codex-a'].map(
          home => [home, runtimeHomeId(home, HOMES) ?? null],
        ),
      ),
    });
  });
});

// ── What follows a stopped ferret ────────────────────────────────────────────────────────────────

type Summary = {
  readonly state: string;
  readonly harness: string;
  readonly runtime?: string;
  readonly cause?: { readonly kind: string; readonly explained?: string };
};

const FERRETS: Readonly<Record<string, Summary>> = {
  codexStopped: { state: 'stopped', harness: 'codex', runtime: 'codex-work', cause: { kind: 'stopped' } },
  codexStopsAgain: { state: 'stopped', harness: 'codex', runtime: 'codex-work', cause: { kind: 'exited' } },
  codexFailed: {
    state: 'stopped',
    harness: 'codex',
    runtime: 'codex-work',
    cause: { kind: 'start_failed', explained: 'golden words for a launch that failed' },
  },
  codexFailedUnexplained: {
    state: 'stopped',
    harness: 'codex',
    runtime: 'codex-work',
    cause: { kind: 'start_failed' },
  },
  codexExplainedButNotFailed: {
    state: 'stopped',
    harness: 'codex',
    runtime: 'codex-work',
    cause: { kind: 'stopped', explained: 'a sentence that must not be told' },
  },
  codexNoRuntime: { state: 'stopped', harness: 'codex', cause: { kind: 'stopped' } },
  codexUnpublished: { state: 'stopped', harness: 'codex', runtime: 'codex-unpublished', cause: { kind: 'stopped' } },
  codexRunning: { state: 'running', harness: 'codex', runtime: 'codex-work' },
  claudeStopped: { state: 'stopped', harness: 'claude-code', runtime: 'claude-work', cause: { kind: 'stopped' } },
  claudeFailed: {
    state: 'stopped',
    harness: 'claude-code',
    runtime: 'claude-work',
    cause: { kind: 'start_failed', explained: 'a sentence that must not be told for Claude' },
  },
};

async function follow(change: FerretChange, options: { readonly noSeams?: boolean; readonly throws?: boolean } = {}) {
  const calls: string[] = [];
  const supervision = new RuntimeEndSupervision({
    ferrets: {
      get: async (id: string) => {
        calls.push(`ferrets.get ${id}`);
        return FERRETS[id] as never;
      },
    } as never,
    seams: options.noSeams
      ? undefined
      : {
          supervisor: {
            afterSessionEnded: async wrapper => {
              calls.push(`afterSessionEnded ${wrapper}`);
              if (options.throws) throw new Error('the fleet folder cannot be opened');
              return { kind: 'stopped', home: `${HOMES}/codex-work`, pids: [11] };
            },
          },
          wrapperOf: async runtime => {
            calls.push(`wrapperOf ${runtime}`);
            return runtime === 'codex-unpublished' ? undefined : `${BIN}/${runtime}`;
          },
        },
    warn: message => calls.push(`warn ${message}`),
    launchFailed: failure => calls.push(`launchFailed ${JSON.stringify(failure)}`),
  });
  await supervision.onChanged(change);
  return calls;
}

describe('runtime end supervision goldens', () => {
  it('should follow each ended ferret exactly as the base does: Codex is looked after, Claude is a no-op', async () => {
    const results: Record<string, unknown> = {};
    for (const ferret of Object.keys(FERRETS))
      results[`${ferret} stopped`] = await follow({ ferret, state: 'stopped' });
    results['an unknown ferret stopped'] = await follow({ ferret: 'nobody', state: 'stopped' });
    results['codexStopped running'] = await follow({ ferret: 'codexStopped', state: 'running' });
    results['codexStopped with no state'] = await follow({ ferret: 'codexStopped' });
    results['codexStopped gone'] = await follow({ ferret: 'codexStopped', gone: true });
    results['codexStopped with the host offering no seams'] = await follow(
      { ferret: 'codexStopped', state: 'stopped' },
      { noSeams: true },
    );
    results['codexFailed when the follow-up throws'] = await follow(
      { ferret: 'codexFailed', state: 'stopped' },
      { throws: true },
    );
    expectGolden('supervision/runtime-end', { results });
  });
});
