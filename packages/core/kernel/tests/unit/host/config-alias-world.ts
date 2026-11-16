/**
 * The booted world of `config-alias-boot.test.ts` (unit: small files, every answer checked) and of
 * `tests/perf/host/config-alias-boot.test.ts` (perf: files at the size limit, every boot timed). It reads no clock.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'bun:test';
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

/**
 * An alias NAME only the file holds, so a message that repeated the name would be caught. Not key-shaped: a name that
 * looks like a key is refused as a raw secret before anything else is said.
 */
export const FAKE_NAME = 'private-anchor-zebraquartz';

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

/** Stops every host and removes every home this file's tests made: the tests' `afterEach`. */
export async function cleanup(): Promise<void> {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** A fresh home, not yet claimed: the first boot claims it (a home that is not empty and unclaimed is refused). */
export async function home(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/config-alias-`);
  roots.push(root);
  return `${root}/home`;
}

export const writeVoice = async (at: string, text: string): Promise<void> => {
  await mkdir(`${at}/config`, { recursive: true });
  await writeFile(`${at}/config/voice.yaml`, text);
};

export type World = Awaited<ReturnType<typeof boot>>;

/** Boots a home, lets `prepare` write into it while it runs (the last good version is accepted by a reload), stops. */
export async function bootOnce(at: string, prepare: (world: World) => Promise<void>): Promise<void> {
  const world = await boot(at);
  await prepare(world);
  await world.host.stop();
  hosts.splice(hosts.indexOf(world.host), 1);
}

export async function boot(at: string) {
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
export function namesNothing(world: World, name: string = FAKE_NAME): void {
  expect(JSON.stringify(world.voiceIssues())).not.toContain(name);
  expect(JSON.stringify(world.logs)).not.toContain(name);
}

/** A file of aliases `size` bytes long (about), the last one unresolved. */
export const aliasesAt = (size: number): string =>
  `limit: 3\nnote: &${FAKE_NAME} x\nmore:\n${`  - *${FAKE_NAME}\n`.repeat(
    Math.floor((size - 256) / (FAKE_NAME.length + 6)),
  )}  - *nope\n`;
