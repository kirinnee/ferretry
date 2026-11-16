/**
 * The testing host's detached spawn stays in step with the real host's: the same rule (`host/detached.ts`) decides
 * both, so a plugin's unit test hears the refusals production gives. The real host is booted for real; only its
 * spawn adapter is a recorder, so no process starts on either side. It also proves the real host's wiring: a refused
 * start never reaches the adapter, an allowed one reaches it with `detached` kept, and the kernel log names the
 * program and pid but never the arguments.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ChildEnvironment } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { ChildHandle, KernelPorts, SpawnOptions, SpawnPort } from '../../../contract/ports.ts';
import { detachedHandle } from '../../../host/detached.ts';
import { bootHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const PID = 7777;
const QUERY = 'planted-query-value';
const URL_WITH_QUERY = `https://example.com/?q=${QUERY}`;

interface Seen {
  browsers?: KernelPorts;
  stranger?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'browsers',
      title: 'Browsers',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { spawn: ['xdg-open', 'chrome', '*'], detached: ['xdg-open', 'rundll32', '*'] },
    }),
    {
      build: ({ kernel }) => {
        seen.browsers = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'stranger',
      title: 'Stranger',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { spawn: ['xdg-open'] },
    }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    },
  ),
];

type Answer = { readonly ok: number } | { readonly refused: string };
const answer = async (call: () => ChildHandle | Promise<unknown>): Promise<Answer> => {
  try {
    const handle = await call();
    return { ok: (handle as ChildHandle).pid };
  } catch (error) {
    return { refused: (error as Error).message };
  }
};

const handle = (): ChildEnvironment =>
  Object.freeze({ names: ['K'], toJSON: () => ({ names: ['K'] }) }) as unknown as ChildEnvironment;

async function cases(seen: Seen): Promise<readonly (readonly [string, Answer])[]> {
  const spawn = (seen.browsers as KernelPorts).spawn;
  const stranger = (seen.stranger as KernelPorts).spawn;
  const go =
    (options: SpawnOptions, program = 'xdg-open') =>
    () =>
      spawn.start(program, [URL_WITH_QUERY], options);
  return [
    ['allowed', await answer(go({ detached: true, env: { DISPLAY: ':0' } }))],
    ['undeclared detached', await answer(go({ detached: true }, 'chrome'))],
    ["'*' names nothing", await answer(go({ detached: true }, 'anything'))],
    ['detached but not spawn', await answer(go({ detached: true }, 'rundll32'))],
    ['another plugin', await answer(() => stranger.start('xdg-open', [], { detached: true }))],
    ['forFerret', await answer(go({ detached: true, forFerret: 'f-1' as FerretId }))],
    ['extraPipes', await answer(go({ detached: true, extraPipes: 1 }))],
    ['stdin', await answer(go({ detached: true, stdin: 'x' }))],
    ['timeout', await answer(go({ detached: true, timeout: 10 as SpawnOptions['timeout'] }))],
    ['a Vault handle', await answer(go({ detached: true, env: handle() }))],
    ['run', await answer(() => spawn.run('xdg-open', [], { detached: true }))],
    ['runBytes', await answer(() => spawn.runBytes('xdg-open', [], { detached: true }))],
  ];
}

async function onTestingHost() {
  const seen: Seen = {};
  const heard: string[] = [];
  const host = await testHost({
    plugins: halves(seen),
    detachedStart: program => {
      heard.push(program);
      return PID;
    },
  });
  try {
    return { answers: await cases(seen), heard };
  } finally {
    await host.stop();
  }
}

/** The real host's adapter: records, starts nothing. */
function recordingSpawn(): SpawnPort & { readonly started: { program: string; options?: SpawnOptions }[] } {
  const started: { program: string; options?: SpawnOptions }[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('the adapter was asked to run');
  };
  return {
    started,
    run: refuse,
    runBytes: refuse,
    start: (program, _args, options) => {
      started.push({ program, ...(options === undefined ? {} : { options }) });
      return detachedHandle(PID);
    },
  };
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-detached-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: Seen = {};
  const records: LogRecord[] = [];
  const spawn = recordingSpawn();
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, record => records.push(record), { binary: 'fy' }),
      spawn,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return { answers: await cases(seen), started: spawn.started, records };
  } finally {
    await outcome.host.stop();
  }
}

test('detached spawn parity: the real host and the testing host answer every case alike', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing.answers).toEqual(real.answers);

  // and what both answer is the rule, not two hosts agreeing on a wrong answer
  const byCase = Object.fromEntries(real.answers);
  expect(byCase.allowed).toEqual({ ok: PID });
  expect(byCase['undeclared detached']).toEqual({
    refused:
      'browsers may not start chrome detached: its manifest does not declare it in permissions.detached and permissions.spawn.',
  });
  expect(byCase["'*' names nothing"]).toEqual({
    refused:
      'browsers may not start anything detached: its manifest does not declare it in permissions.detached and permissions.spawn.',
  });
  // rundll32 is in detached; spawn's '*' is a non-core manifest's, so it grants nothing
  expect(byCase['detached but not spawn']).toEqual({
    refused:
      'browsers may not start rundll32 detached: its manifest does not declare it in permissions.detached and permissions.spawn.',
  });
  expect(byCase['another plugin']).toEqual({
    refused:
      'stranger may not start xdg-open detached: its manifest does not declare it in permissions.detached and permissions.spawn.',
  });
  for (const name of ['forFerret', 'extraPipes', 'stdin', 'timeout', 'a Vault handle', 'run', 'runBytes'])
    expect(Object.keys(byCase[name] ?? {})).toEqual(['refused']);

  // the testing host's fake and the real adapter each heard the one allowed start, and nothing refused
  expect(testing.heard).toEqual(['xdg-open']);
  expect(real.started).toEqual([{ program: 'xdg-open', options: { detached: true, env: { DISPLAY: ':0' } } }]);

  // the kernel log names the plugin, the program and the pid, and never an argument
  const logged = real.records.filter(record => record.message === 'a detached child was started');
  expect(logged.map(record => record.fields)).toEqual([{ plugin: 'browsers', program: 'xdg-open', pid: PID }]);
  expect(JSON.stringify(real.records)).not.toContain(QUERY);
});
