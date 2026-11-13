/**
 * The private-files rule on BOTH hosts. The real host composes every plugin's `privacy.private` into the one list the
 * fence of every root reads, and refuses to start with a manifest that declares its private files unsoundly; the testing
 * host refuses the same manifest, so a plugin's unit test cannot hold what production will not boot. The real host is
 * booted for real over a temp home: a hard link to a plugin's private file placed in ANOTHER plugin's agent home is
 * refused `fenced` (the composed list at work) rather than `hard_link` (the weaker rule that stood alone before).
 */
import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { AdmissionPort } from '../../../contract/bound.ts';
import { ApiError } from '../../../contract/http.ts';
import type { LogRecord } from '../../../host/log.ts';
import { recordingAdmission, request } from '../host/fixtures.ts';
import { tmpdir } from 'node:os';
import { defineState } from '../../../contract/define.ts';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { RootError } from '../../../host/roots.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const KEY = defineState({ name: 'signing', path: 'signing.key', store: 'secret', format: 1 });

const base = { title: 'Sample', version: '5.0.0', api: 5 as const, core: false, kinds: [] as const };

const holder = (privacy: Manifest['privacy']) => ({
  ...base,
  id: 'holder',
  data: { state: [KEY] },
  ...(privacy === undefined ? {} : { privacy }),
});

const halves = (seen: { stranger?: KernelPorts }, privacy: Manifest['privacy']) => [
  implementDaemon(holder(privacy) as unknown as Manifest, { build: () => ({}) }),
  implementDaemon(definePlugin({ ...base, id: 'stranger', permissions: { roots: ['agent-homes'] } }), {
    build: ({ kernel }) => {
      seen.stranger = kernel;
      return {};
    },
  }),
];

const SOUND = { private: ['signing.key'] } as const;

test('PF-parity a manifest that leaves a secret-named state file undeclared is refused by BOTH hosts', async () => {
  await expect(testHost({ plugins: halves({}, undefined) })).rejects.toThrow('is named like a secret');
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves({}, undefined),
  });
  expect(outcome.kind).toBe('refused');
  if (outcome.kind === 'refused') {
    expect(outcome.sentence).toContain('signing.key');
    expect(outcome.sentence).toContain('privacy.private');
  }
});

test('PF-parity a sound declaration boots on both hosts', async () => {
  const host = await testHost({ plugins: halves({}, SOUND) });
  await host.stop();
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves({}, SOUND),
  });
  expect(outcome.kind).toBe('running');
  if (outcome.kind === 'running') await outcome.host.stop();
});

test('PF-parity the real host composes the declared list into every root: a hard link of a private file in another plugin agent home is fenced', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: { stranger?: KernelPorts } = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen, SOUND),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const key = `${home}/state/holder/signing.key`;
    await mkdir(`${home}/state/holder`, { recursive: true });
    await writeFile(key, 'signing-fixture', { mode: 0o600 });
    const roots = (seen.stranger as KernelPorts).roots;
    const agentHome = roots.root('agent-homes', { subfolder: 'F1' });
    const at = (name: string): FencedPath => {
      const resolved = agentHome.resolve(name);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    await agentHome.writeText(at('own.txt'), 'own');
    await link(key, `${home}/state/stranger/agent-homes/F1/borrowed.json`);
    const refusal = async (): Promise<string> => {
      try {
        await agentHome.readText(at('borrowed.json'));
        return 'allowed';
      } catch (error) {
        return error instanceof RootError ? error.refusal : String(error);
      }
    };
    expect(await refusal()).toBe('fenced');
    expect(await agentHome.readText(at('own.txt'))).toBe('own');
    expect(await readFile(key, 'utf8')).toBe('signing-fixture');
  } finally {
    await outcome.host.stop();
  }
});

test('PF-parity the real host looks at the private places again: a file made after the first fenced read is fenced once the look interval has passed', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: { stranger?: KernelPorts } = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen, SOUND),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const roots = (seen.stranger as KernelPorts).roots;
    const agentHome = roots.root('agent-homes', { subfolder: 'F1' });
    const at = (name: string): FencedPath => {
      const resolved = agentHome.resolve(name);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    // The first fenced read builds the kept index while the private file does not exist yet.
    await agentHome.writeText(at('own.txt'), 'own');
    expect(await agentHome.readText(at('own.txt'))).toBe('own');
    const key = `${home}/state/holder/signing.key`;
    await mkdir(`${home}/state/holder`, { recursive: true });
    await writeFile(key, 'signing-fixture', { mode: 0o600 });
    await link(key, `${home}/state/stranger/agent-homes/F1/borrowed.json`);
    // The host's look interval is 250 ms: past it, the next read looks again and finds the file.
    await new Promise(done => setTimeout(done, 400));
    const refusal = async (): Promise<string> => {
      try {
        await agentHome.readText(at('borrowed.json'));
        return 'allowed';
      } catch (error) {
        return error instanceof RootError ? error.refusal : String(error);
      }
    };
    expect(await refusal()).toBe('fenced');
  } finally {
    await outcome.host.stop();
  }
});

test('PF-loud the real host says so when a private place passes its budget: one log line, a failing doctor line, and a line when it fits again', async () => {
  const VAULT = defineState({ name: 'vault', path: 'vault/*', store: 'opaque', format: 1 });
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: { stranger?: KernelPorts } = {};
  const records: LogRecord[] = [];
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, record => records.push(record), { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(definePlugin({ ...base, id: 'gate', core: true, provides: { admission: AdmissionPort } }), {
        build: () => ({ provides: { admission: recordingAdmission() } }),
      }),
      implementDaemon(
        definePlugin({ ...base, id: 'holder', data: { state: [VAULT] }, privacy: { private: ['vault'] } }),
        { build: () => ({}) },
      ),
      implementDaemon(definePlugin({ ...base, id: 'stranger', permissions: { roots: ['agent-homes'] } }), {
        build: ({ kernel }) => {
          seen.stranger = kernel;
          return {};
        },
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const agentHome = (seen.stranger as KernelPorts).roots.root('agent-homes', { subfolder: 'F1' });
    const own = agentHome.resolve('own.txt');
    if (!own.ok) throw new Error(own.error);
    await agentHome.writeText(own.value, 'own');
    const readOwn = async (): Promise<string> => {
      try {
        return await agentHome.readText(own.value);
      } catch (error) {
        return error instanceof RootError ? error.refusal : String(error);
      }
    };
    // The index looks at the folders again at its own interval: ask until the answer is the wanted one (a deadline, not a
    // fixed sleep), so a slow disk or a loaded runner only makes the wait longer and never the answer different.
    const readUntil = async (wanted: string): Promise<string> => {
      const deadline = Date.now() + 15_000;
      let answer = await readOwn();
      while (answer !== wanted && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 50));
        answer = await readOwn();
      }
      return answer;
    };
    const ours = (): readonly LogRecord[] => records.filter(record => record.message.includes('private place'));
    const doctored = async (): Promise<readonly string[]> =>
      (await outcome.host.doctor()).filter(line => line.detail.includes('private place')).map(line => line.state);
    expect(await readOwn()).toBe('own');
    expect(ours()).toEqual([]);
    expect(await doctored()).toEqual([]);
    // A private folder with more places than its budget (4096).
    const vault = `${home}/state/holder/vault`;
    await mkdir(vault, { recursive: true });
    for (let from = 0; from < 4100; from += 200)
      await Promise.all(Array.from({ length: 200 }, (_, at) => writeFile(`${vault}/f${from + at}`, 'x')));
    expect(await readUntil('fenced')).toBe('fenced');
    // Said once, with the place and the counts, and kept as a failing line until it fits again.
    expect(await readOwn()).toBe('fenced');
    expect(ours().length).toBe(1);
    expect(ours()[0]?.level).toBe('warn');
    expect(ours()[0]?.fields).toEqual({ place: 'state/holder/vault', indexed: 4096, limit: 4096 });
    expect(await doctored()).toEqual(['fail']);
    const line = (await outcome.host.doctor()).find(found => found.detail.includes('private place'));
    expect(line?.detail).toContain('state/holder/vault');
    expect(line?.fix).toContain('state/holder/vault');
    // The same line is in `GET /v1/doctor`, the route `fy doctor` and the app read.
    const route = await outcome.host.dispatch(request('GET', '/v1/doctor'));
    expect(route.status).toBe(200);
    expect(route.body).toContain('state/holder/vault');
    // It fits again: the refusal is lifted at the next look, said once, and the failing line is gone.
    await Promise.all(Array.from({ length: 200 }, (_, at) => rm(`${vault}/f${at}`)));
    expect(await readUntil('own')).toBe('own');
    expect(ours().length).toBe(2);
    expect(ours()[1]?.message).toContain('fits its budget again');
    expect(await doctored()).toEqual([]);
  } finally {
    await outcome.host.stop();
  }
}, 30_000);

test('S40 PF-parity a private file created through the state port is pinned before the write returns, on both hosts', async () => {
  const seen: { holder?: KernelPorts; stranger?: KernelPorts } = {};
  const both = (privacy: Manifest['privacy']) => [
    implementDaemon(holder(privacy) as unknown as Manifest, {
      build: ({ kernel }) => {
        seen.holder = kernel;
        return {};
      },
    }),
    implementDaemon(definePlugin({ ...base, id: 'stranger', permissions: { roots: ['agent-homes'] } }), {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    }),
  ];
  // The testing host takes the same write and keeps it: it has no disk to pin, and it does not refuse the create.
  const fake = await testHost({ plugins: both(SOUND) });
  await (seen.holder as KernelPorts).state.write(KEY, 'signing-fixture');
  await fake.stop();
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const real = realAdapters(home, () => {}, { binary: 'fy' });
  // Every look at a folder of the state tree is counted: the index lists `state` each time it builds.
  let lists = 0;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...real,
      fs: {
        ...real.fs,
        list: async path => {
          if (path === `${home}/state` || path.endsWith('/state')) lists += 1;
          return await real.fs.list(path);
        },
      },
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: both(SOUND),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const agentHome = (seen.stranger as KernelPorts).roots.root('agent-homes', { subfolder: 'F1' });
    const own = agentHome.resolve('own.txt');
    if (!own.ok) throw new Error(own.error);
    await agentHome.writeText(own.value, 'own');
    await agentHome.readText(own.value);
    const before = lists;
    await (seen.holder as KernelPorts).state.write(KEY, 'signing-fixture');
    // The write itself looked at the state tree again (the host's 250 ms interval had not passed).
    expect(lists).toBeGreaterThan(before);
    await link(`${home}/state/holder/signing.key`, `${home}/state/stranger/agent-homes/F1/borrowed.json`);
    const borrowed = agentHome.resolve('borrowed.json');
    if (!borrowed.ok) throw new Error(borrowed.error);
    const refusal = await agentHome.readText(borrowed.value).then(
      () => 'allowed',
      (error: unknown) => (error instanceof RootError ? error.refusal : String(error)),
    );
    expect(refusal).toBe('fenced');
  } finally {
    await outcome.host.stop();
  }
});

test('S40 PF-loud the host says a failed pin once per outage and says it again after a look has succeeded', async () => {
  const seen: { holder?: KernelPorts } = {};
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const records: LogRecord[] = [];
  const real = realAdapters(home, record => records.push(record), { binary: 'fy' });
  let broken = false;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...real,
      fs: {
        ...real.fs,
        // Every look resolves the home first, so this fails each look (a later look may skip an unchanged folder's list).
        realpath: async path => {
          if (broken && path === home) throw Object.assign(new Error(`cannot resolve ${path}`), { code: 'EIO' });
          return await real.fs.realpath(path);
        },
      },
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(holder(SOUND) as unknown as Manifest, {
        build: ({ kernel }) => {
          seen.holder = kernel;
          return {};
        },
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const state = (seen.holder as KernelPorts).state;
    const told = (): number => records.filter(record => record.message.includes('could not be pinned')).length;
    const failing = (): Promise<unknown> =>
      state.write(KEY, 'signing-fixture').then(
        () => undefined,
        (error: unknown) => error,
      );
    broken = true;
    expect(await failing()).toBeInstanceOf(ApiError);
    expect(await failing()).toBeInstanceOf(ApiError);
    expect(told()).toBe(1);
    broken = false;
    await state.write(KEY, 'signing-fixture');
    broken = true;
    expect(await failing()).toBeInstanceOf(ApiError);
    expect(told()).toBe(2);
  } finally {
    await outcome.host.stop();
  }
});

test('S40 row 49 PF-loud the booted host hands its pin report to every plugin root: a root write that cannot be pinned is told once', async () => {
  const seen: { ferrets?: KernelPorts } = {};
  const parent = await realpath(await mkdtemp(`${tmpdir()}/private-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const records: LogRecord[] = [];
  const real = realAdapters(home, record => records.push(record), { binary: 'fy' });
  // One write resolves the home several times; only the LAST resolving (the pin's) fails, so the write itself lands.
  let resolvings = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...real,
      fs: {
        ...real.fs,
        realpath: async path => {
          if (path === home) {
            resolvings += 1;
            if (resolvings === failAt) throw Object.assign(new Error(`cannot resolve ${path}`), { code: 'EIO' });
          }
          return await real.fs.realpath(path);
        },
      },
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(
        {
          ...base,
          id: 'ferrets',
          permissions: { roots: ['sessions'] },
          privacy: { private: ['sessions/*/environment.json'] },
        } as unknown as Manifest,
        {
          build: ({ kernel }) => {
            seen.ferrets = kernel;
            return {};
          },
        },
      ),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const session = (seen.ferrets as KernelPorts).roots.root('sessions', { subfolder: 'mw7bp88g-50e00159' });
    const environment = session.resolve('environment.json');
    if (!environment.ok) throw new Error(environment.error);
    const told = (): number => records.filter(record => record.message.includes('could not be pinned')).length;
    const write = (): Promise<unknown> =>
      session.writeText(environment.value as FencedPath, 'FAKE-credential').then(
        () => undefined,
        (error: unknown) => error,
      );
    // The first write makes the session folder; the second is a plain replace, the same shape as the failing ones.
    await write();
    const before = resolvings;
    await write();
    const perWrite = resolvings - before;
    const failing = async (): Promise<unknown> => {
      resolvings = 0;
      failAt = perWrite;
      return await write();
    };
    expect(await failing()).toBeInstanceOf(ApiError);
    expect(await failing()).toBeInstanceOf(ApiError);
    expect(told()).toBe(1);
  } finally {
    await outcome.host.stop();
  }
});
