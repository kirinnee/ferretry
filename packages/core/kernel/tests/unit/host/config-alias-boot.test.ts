/**
 * A file whose YAML aliases cannot be read — an alias to an anchor that is not set, or an alias inside its own anchor —
 * is a broken file like any other (docs/config-files.md, "Last good wins"): it is refused with a located issue, its last
 * good version stays in effect, boot continues and a reload never throws. No issue or log line names the alias.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AGENT_CONFIG_TEXT_MAX_BYTES } from '../../../contract/agent-config.ts';
import { AdmissionPort } from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigPort } from '../../../contract/ports.ts';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { bootHost, type HostConfig, type RunningHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { adversarialTexts, PRIVATE_WORD } from '../host-config/adversarial-texts.ts';
import { recordingAdmission } from './fixtures.ts';

/**
 * An alias NAME only the file holds, so a message that repeated the name would be caught. Not key-shaped: a name that
 * looks like a key is refused as a raw secret before anything else is said (the last test here).
 */
const FAKE_NAME = 'private-anchor-zebraquartz';
/** Fake only: an alias name shaped like a key. */
const KEY_NAME = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UNRESOLVED = `limit: 3\nnote: *${FAKE_NAME}\n`;
const LOOP = `limit: 3\nnote: &${FAKE_NAME}\n  again: *${FAKE_NAME}\n`;
/**
 * Billion laughs: each anchor nine of the one before. The third (line 4) reads out past the budget: a value weighs its
 * length, so nine copies of the name nine times over is already some 20 000 characters.
 */
const BOMB = `limit: 3\n${Array.from(
  { length: 10 },
  (_, level) =>
    `l${level}: &l${level} [${Array.from({ length: 9 }, () => (level === 0 ? FAKE_NAME : `*l${level - 1}`)).join(', ')}]\n`,
).join('')}`;
/** A file at the agent door's size limit, every line an alias, the last one unresolved. */
const AT_THE_LIMIT = `limit: 3\nnote: &${FAKE_NAME} x\nmore:\n${`  - *${FAKE_NAME}\n`.repeat(
  Math.floor((AGENT_CONFIG_TEXT_MAX_BYTES - 256) / (FAKE_NAME.length + 6)),
)}  - *nope\n`;
/** A hard bound, far above one linear read; the quadratic read this guards took minutes on a file this size. */
const BOUND_MS = 1500;

const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.unknown().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});

const base = { version: '5.0.0', api: 5, kinds: [] } as const;
const gate = definePlugin({ ...base, id: 'gate', title: 'Gate', core: true, provides: { admission: AdmissionPort } });
const voice = definePlugin({ ...base, id: 'voice', title: 'Voice', core: false, data: { config: [voiceDef] } });

const roots: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A fresh home, not yet claimed: the first boot claims it (a home that is not empty and unclaimed is refused). */
async function home(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/config-alias-`);
  roots.push(root);
  return `${root}/home`;
}

const writeVoice = async (at: string, text: string): Promise<void> => {
  await mkdir(`${at}/config`, { recursive: true });
  await writeFile(`${at}/config/voice.yaml`, text);
};

/** Boots a home, lets `prepare` write into it while it runs (the last good version is accepted by a reload), stops. */
async function bootOnce(
  at: string,
  prepare: (world: Awaited<ReturnType<typeof boot>>) => Promise<void>,
): Promise<void> {
  const world = await boot(at);
  await prepare(world);
  await world.host.stop();
  hosts.splice(hosts.indexOf(world.host), 1);
}

async function boot(at: string) {
  const logs: LogRecord[] = [];
  let service: HostConfig | undefined;
  let port: ConfigPort | undefined;
  const real = realAdapters(at, record => logs.push(record), { binary: 'fy' });
  const outcome = await bootHost({
    home: at,
    version: '5.0.0',
    adapters: {
      ...real,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
      config: (declarations, judge) => {
        service = real.config(declarations, judge);
        return service;
      },
    },
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) }),
      implementDaemon(voice, {
        build: ctx => {
          port = ctx.kernel.config;
          return {};
        },
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  if (service === undefined || port === undefined) throw new Error('the fixture was not built');
  const config = service;
  const reader = port;
  return {
    home: at,
    host: outcome.host,
    logs,
    reload: () => config.reload(),
    limit: () => reader.file(voiceDef)?.limit,
    voiceIssues: () => (config.status?.().issues ?? []).filter(issue => issue.path === 'voice.yaml'),
    voiceState: () => config.status?.().files.find(file => file.path === 'voice.yaml')?.state,
  };
}

/** Nothing the daemon says about the file — an issue, a log line — repeats the alias's name. */
function namesNothing(world: Awaited<ReturnType<typeof boot>>, name: string = FAKE_NAME): void {
  expect(JSON.stringify(world.voiceIssues())).not.toContain(name);
  expect(JSON.stringify(world.logs)).not.toContain(name);
}

describe('an alias that cannot be read is a broken file, not a crash', () => {
  for (const [label, text, message, line] of [
    ['an unresolved alias', UNRESOLVED, 'names an anchor (&name) that is not set before it', 2],
    ['an alias loop', LOOP, 'sits inside the anchor (&name) it names', 3],
    ['an alias bomb', BOMB, 'expand too far to read', 4],
  ] as const) {
    test(`${label} at boot: boot continues and the last good version stays in effect`, async () => {
      const at = await home();
      await bootOnce(at, async first => {
        await writeVoice(at, 'limit: 7\n');
        await first.reload();
        expect(first.limit()).toBe(7);
      });

      await writeVoice(at, text);
      const world = await boot(at);
      expect(world.limit()).toBe(7);
      expect(world.voiceState()).toBe('invalid');
      const [issue] = world.voiceIssues();
      expect(issue?.message).toContain(message);
      expect(issue?.line).toBe(line);
      namesNothing(world);
    });

    test(`${label} at boot with no last good version: boot continues with nothing of the file in effect`, async () => {
      const at = await home();
      await bootOnce(at, async () => {});
      await writeVoice(at, text);
      const world = await boot(at);
      expect(world.voiceState()).toBe('invalid');
      // Nothing was ever accepted, so nothing of the file is in effect: the plugin reads no value and keeps its defaults.
      expect(world.limit()).toBeUndefined();
      namesNothing(world);
    });

    test(`${label} on reload: the reload resolves, the last good version stays, and a fix applies`, async () => {
      const world = await boot(await home());
      const at = world.home;
      await writeVoice(at, 'limit: 7\n');
      await world.reload();
      expect(world.limit()).toBe(7);

      await writeVoice(at, text);
      await world.reload();
      expect(world.limit()).toBe(7);
      expect(world.voiceState()).toBe('invalid');
      expect(world.voiceIssues()[0]?.message).toContain(message);
      namesNothing(world);

      await writeVoice(at, 'limit: 4\n');
      await world.reload();
      expect(world.limit()).toBe(4);
      expect(world.voiceIssues()).toEqual([]);
    });
  }
});

describe('a file at the size limit is read in one pass at boot and on reload', () => {
  test('a 256 KiB file of aliases, the last unresolved: boot and the reload each read it in under the bound', async () => {
    const at = await home();
    await bootOnce(at, async first => {
      await writeVoice(at, 'limit: 7\n');
      await first.reload();
    });
    await writeVoice(at, AT_THE_LIMIT);

    const booting = performance.now();
    const world = await boot(at);
    // Boot does more than read one file; the read itself is what the bound is about, so it is given the bound twice.
    expect(performance.now() - booting).toBeLessThan(BOUND_MS * 2);
    expect(world.limit()).toBe(7);
    expect(world.voiceIssues()[0]?.message).toContain('not set before it');

    const reloading = performance.now();
    await world.reload();
    expect(performance.now() - reloading).toBeLessThan(BOUND_MS);
    expect(world.limit()).toBe(7);
    namesNothing(world);
  });
});

describe('every hostile shape at the size cap: boot reads it within the bound and never fails', () => {
  for (const [label, text] of adversarialTexts(CONFIG_FILE_MAX_BYTES)) {
    test(`${label}: boot answers in under ${BOUND_MS} ms, and the last good version stays unless the file checks`, async () => {
      const at = await home();
      await bootOnce(at, async first => {
        await writeVoice(at, 'limit: 7\n');
        await first.reload();
      });
      await writeVoice(at, text);

      const booting = performance.now();
      const world = await boot(at);
      expect(performance.now() - booting).toBeLessThan(BOUND_MS);
      if (world.voiceState() !== 'ok') expect(world.limit()).toBe(7);
      namesNothing(world, PRIVATE_WORD);
    });
  }

  test('a file over the cap at boot is not read: boot continues and the last good version stays', async () => {
    const at = await home();
    await bootOnce(at, async first => {
      await writeVoice(at, 'limit: 7\n');
      await first.reload();
    });
    await writeVoice(at, `note: ${PRIVATE_WORD}\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`);

    const world = await boot(at);
    expect(world.limit()).toBe(7);
    expect(world.voiceState()).toBe('invalid');
    namesNothing(world, PRIVATE_WORD);
  });
});

describe('an unreadable alias whose name looks like a key', () => {
  test('is refused as a raw secret by its line alone, before anything is said about the alias (R5)', async () => {
    const world = await boot(await home());
    await writeVoice(world.home, 'limit: 7\n');
    await world.reload();

    await writeVoice(world.home, `limit: 3\nnote: *${KEY_NAME}\n`);
    await world.reload();
    expect(world.limit()).toBe(7);
    expect(world.voiceIssues()).toMatchObject([{ line: 2, column: 1, message: expect.stringContaining('raw secret') }]);
    namesNothing(world, KEY_NAME);
  });
});
