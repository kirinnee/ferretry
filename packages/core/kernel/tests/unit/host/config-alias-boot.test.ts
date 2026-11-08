/**
 * A file whose YAML aliases cannot be read — an alias to an anchor that is not set, or an alias inside its own anchor —
 * is a broken file like any other (docs/config-files.md, "Last good wins"): it is refused with a located issue, its last
 * good version stays in effect, boot continues and a reload never throws. No issue or log line names the alias.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort } from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/index.ts';
import type { ConfigPort } from '../../../contract/ports.ts';
import { bootHost, type HostConfig, type RunningHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission } from './fixtures.ts';

/** Fake only: an alias NAME shaped like a key, so a message that repeated the name would be caught. */
const FAKE_NAME = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UNRESOLVED = `limit: 3\nnote: *${FAKE_NAME}\n`;
const LOOP = `limit: 3\nnote: &${FAKE_NAME}\n  again: *${FAKE_NAME}\n`;

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
function namesNothing(world: Awaited<ReturnType<typeof boot>>): void {
  expect(JSON.stringify(world.voiceIssues())).not.toContain(FAKE_NAME);
  expect(JSON.stringify(world.logs)).not.toContain(FAKE_NAME);
}

describe('an alias that cannot be read is a broken file, not a crash', () => {
  for (const [label, text, message, line] of [
    ['an unresolved alias', UNRESOLVED, 'names an anchor (&name) that is not set before it', 2],
    ['an alias loop', LOOP, 'sits inside the anchor (&name) it names', 3],
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
