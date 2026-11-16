/**
 * BG-009 (LOW-B): a detached start through a spawn RESOLVER is answered alike by the real host and the testing host. The
 * resolver's answer names the program (an absolute answer allows only that path, a bare one its basename) and
 * `permissions.detached` names what may start detached; each host asks the resolver at the call. The real host is booted
 * for real with a recording spawn adapter, so no process starts on either side.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ChildHandle, KernelPorts, SpawnOptions, SpawnPort } from '../../../contract/ports.ts';
import { detachedHandle } from '../../../host/detached.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const PID = 7778;

interface Seen {
  opening?: KernelPorts;
}

type Answers = { current: readonly string[] };

const halves = (seen: Seen, answers: Answers) => [
  implementDaemon(
    definePlugin({
      id: 'opening',
      title: 'Opening',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { spawn: [{ resolver: 'check' }], detached: ['opener'] },
    }),
    {
      build: ({ kernel }) => {
        seen.opening = kernel;
        return { resolvers: { check: () => answers.current } };
      },
    },
  ),
];

type Answer = { readonly ok: number } | { readonly refused: string };
const answer = async (call: () => ChildHandle): Promise<Answer> => {
  try {
    return { ok: call().pid };
  } catch (error) {
    return { refused: (error as Error).message };
  }
};

async function cases(seen: Seen, answers: Answers): Promise<readonly (readonly [string, Answer])[]> {
  const spawn = (seen.opening as KernelPorts).spawn;
  const go = (program: string) => () => spawn.start(program, [], { detached: true });
  const out: (readonly [string, Answer])[] = [];
  answers.current = ['/opt/x/opener'];
  for (const program of ['/opt/x/opener', '/tmp/opener', 'opener', '/opt/x/OPENER'])
    out.push([`exact answer: ${program}`, await answer(go(program))]);
  answers.current = ['opener'];
  for (const program of ['opener', '/usr/bin/opener', 'mopener'])
    out.push([`bare answer: ${program}`, await answer(go(program))]);
  answers.current = [];
  out.push(['no answer: opener', await answer(go('opener'))]);
  answers.current = ['*'];
  out.push(['wildcard answer: opener', await answer(go('opener'))]);
  answers.current = ['other'];
  out.push(['an answer for another program: opener', await answer(go('opener'))]);
  return out;
}

async function onTestingHost() {
  const seen: Seen = {};
  const answers: Answers = { current: [] };
  const heard: string[] = [];
  const host = await testHost({
    plugins: halves(seen, answers),
    detachedStart: program => {
      heard.push(program);
      return PID;
    },
  });
  try {
    return { answers: await cases(seen, answers), heard };
  } finally {
    await host.stop();
  }
}

/** The real host's adapter: records, starts nothing. */
function recordingSpawn(): SpawnPort & { readonly started: string[] } {
  const started: string[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('the adapter was asked to run');
  };
  return {
    started,
    run: refuse,
    runBytes: refuse,
    start: (program, _args, _options?: SpawnOptions) => {
      started.push(program);
      return detachedHandle(PID);
    },
  };
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-detached-resolver-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: Seen = {};
  const answers: Answers = { current: [] };
  const spawn = recordingSpawn();
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => undefined, { binary: 'fy' }),
      spawn,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen, answers),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return { answers: await cases(seen, answers), started: spawn.started };
  } finally {
    await outcome.host.stop();
  }
}

test('BG-009 detached start through a spawn resolver: the real host and the testing host answer every case alike', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing.answers).toEqual(real.answers);

  // and what both answer is the rule (an absolute answer allows only that path, case exact; a bare one its basename)
  const byCase = Object.fromEntries(real.answers);
  const ok = { ok: PID };
  expect(byCase['exact answer: /opt/x/opener']).toEqual(ok);
  for (const refused of [
    'exact answer: /tmp/opener',
    'exact answer: opener',
    'exact answer: /opt/x/OPENER',
    'bare answer: mopener',
    'no answer: opener',
    'wildcard answer: opener',
    'an answer for another program: opener',
  ])
    expect(Object.keys(byCase[refused] ?? {})).toEqual(['refused']);
  expect(byCase['bare answer: opener']).toEqual(ok);
  expect(byCase['bare answer: /usr/bin/opener']).toEqual(ok);

  // the one program each host's adapter heard are exactly the allowed starts, and no refused one reached it
  const allowed = ['/opt/x/opener', 'opener', '/usr/bin/opener'];
  expect(testing.heard).toEqual(allowed);
  expect(real.started).toEqual(allowed);
});
