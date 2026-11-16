import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

const parents: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const base = { version: '5.0.0', api: 5, core: false, kinds: [] } as const;

/** A real boot on a temp home with a clock that moves 5 ms on every read, so every phase has a duration. */
async function bootRecording(ids: readonly string[]) {
  const parent = await mkdtemp(`${tmpdir()}/boot-phases-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const records: LogRecord[] = [];
  const fixed = fixedClock();
  let now = 0;
  const clock = { ...fixed, nowMs: () => (now += 5) };
  const real = realAdapters(home, () => {}, { binary: 'fy' });
  const adapters: HostOptions['adapters'] = {
    ...real,
    logSink: record => records.push(record),
    clock,
    homeLock: async () => ({ release: async () => {} }),
    state: stateOpener(home, createMemoryHostFs(), clock, silentLog),
  };
  const implementations = ids.map(id =>
    implementDaemon(definePlugin({ ...base, id, title: id }), { build: () => ({}) }),
  );
  const result = await bootHost({ home, version: '5.0.0', implementations, adapters });
  if (result.kind !== 'running') throw new Error(result.sentence);
  hosts.push(result.host);
  return { home, records, host: result.host };
}

describe('the daemon says where its boot time went', () => {
  test('one line of phases, in boot order, comes just before the serving line', async () => {
    const { records } = await bootRecording(['alpha', 'beta']);
    const messages = records.map(record => record.message);
    const serving = messages.indexOf('the daemon is serving');
    expect(serving).toBeGreaterThan(0);
    const line = messages[serving - 1] as string;
    expect(line).toMatch(
      /^boot phases: home \d+ms, lock \d+ms, identity \d+ms, config \d+ms, check \d+ms, state \d+ms \((state:\w+ \d+ms(, )?)+\), build \d+ms \((build:\w+ \d+ms(, )?)+\), bind \d+ms, snapshot \d+ms, mount \d+ms, listen \d+ms, jobs \d+ms; total \d+ms$/,
    );
    expect(line).toContain('state:alpha');
    expect(line).toContain('build:beta');
    expect(messages.filter(message => message.startsWith('boot phases:'))).toHaveLength(1);
  });

  test('the line names no path: the home folder is not in it', async () => {
    const { records, home } = await bootRecording(['alpha']);
    const text = records.map(record => record.message).find(message => message.startsWith('boot phases:')) as string;
    expect(text).not.toContain(home);
    expect(text).not.toContain('/');
  });

  test('the boot trace keeps its phases in the same order', async () => {
    const { host } = await bootRecording(['alpha']);
    const fixed = host.trace.filter(label =>
      /^(home|lock|identity|config|check|bind|snapshot|mount|listen|jobs)$/.test(label),
    );
    expect(fixed).toEqual([
      'home',
      'lock',
      'identity',
      'config',
      'check',
      'bind',
      'snapshot',
      'mount',
      'listen',
      'jobs',
    ]);
  });
});
