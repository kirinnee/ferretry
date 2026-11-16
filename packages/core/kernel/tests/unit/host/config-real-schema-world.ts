/**
 * The world of `config-real-schema-boot.test.ts` (unit: a small text, every answer checked) and of
 * `tests/perf/host/config-real-schema-boot.test.ts` (perf: the text at the size cap, the boot timed). It reads no
 * clock: what is measured is the caller's, handed in as `timed`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'bun:test';
import { AdmissionPort } from '../../../contract/bound.ts';
import { MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { bootHost, type HostConfig, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import type { DeclaredKind } from '../host-config/real-schemas.ts';
import { recordingAdmission } from './fixtures.ts';

/** What a boot cost as the caller measures it, in ms; the unit tier measures nothing (the cost is 0). */
export type Timed = <T>(act: () => Promise<T>) => Promise<{ readonly ms: number; readonly value: T }>;

/** The unit tier's measure: nothing is timed. */
export const UNTIMED: Timed = async act => ({ ms: 0, value: await act() });

const base = { version: '5.0.0', api: 5, kinds: [] } as const;
const gate = definePlugin({ ...base, id: 'gate', title: 'Gate', core: true, provides: { admission: AdmissionPort } });

const roots: string[] = [];
const hosts: RunningHost[] = [];

/** Stops every host and removes every home this file's tests made: the tests' `afterEach`. */
export async function cleanup(): Promise<void> {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** A home claimed by a first boot (an unclaimed home that is not empty is refused), then holding `text` as the file. */
async function homeWith(kind: DeclaredKind, text: string): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/config-real-schema-`);
  roots.push(root);
  const at = `${root}/home`;
  await boot(at, kind);
  for (const host of hosts.splice(0)) await host.stop();
  const file = `${at}/config/${kind.path}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return at;
}

/** Boots `at` with one plugin that declares `kind`'s real definition, as that kind's own plugin does. */
async function boot(at: string, kind: DeclaredKind) {
  let service: HostConfig | undefined;
  const real = realAdapters(at, () => {}, { binary: 'fy' });
  const holder = definePlugin({
    ...base,
    id: kind.plugin,
    title: kind.plugin,
    core: false,
    data: { config: [kind.def] },
  });
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
      implementDaemon(holder, { build: () => ({}) }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  hosts.push(outcome.host);
  if (service === undefined) throw new Error('the fixture was not built');
  return service;
}

/**
 * Writes `text` as `kind`'s file, boots, and checks the answer; returns what the boot cost as `timed` measured it.
 * Refused with its problems capped — or, for a kind whose schema takes any value there (a settings file), read.
 */
export async function bootsCapped(kind: DeclaredKind, text: string, timed: Timed): Promise<number> {
  const at = await homeWith(kind, text);
  const { ms, value: service } = await timed(() => boot(at, kind));
  const status = service.status?.();
  const file = status?.files.find(entry => entry.path === kind.path);
  const issues = (status?.issues ?? []).filter(issue => issue.path === kind.path);
  if (file?.state === 'ok') expect(issues).toEqual([]);
  else {
    expect(file?.state).toBe('invalid');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(MAX_CONFIG_ISSUES + 1);
  }
  return ms;
}
