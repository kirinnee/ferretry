/**
 * The private-files rule on BOTH hosts. The real host composes every plugin's `privacy.private` into the one list the
 * fence of every root reads, and refuses to start with a manifest that declares its private files unsoundly; the testing
 * host refuses the same manifest, so a plugin's unit test cannot hold what production will not boot. The real host is
 * booted for real over a temp home: a hard link to a plugin's private file placed in ANOTHER plugin's agent home is
 * refused `fenced` (the composed list at work) rather than `hard_link` (the weaker rule that stood alone before).
 */
import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
