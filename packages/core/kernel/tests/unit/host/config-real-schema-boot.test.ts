/**
 * Boot with a hand-written file of a REAL declared kind at the size cap, wrong for its own schema: boot answers within
 * one hard bound, never fails, puts nothing wrong in effect, and its problems are listed at most
 * {@link MAX_CONFIG_ISSUES} and one sentence counting the rest. The kinds an agent may name are each booted with their
 * sweep text, and the real `mcp/<name>.yaml` with review round 7's shapes. The other doors are
 * `../host-config/real-schema-bound.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { AdmissionPort } from '../../../contract/bound.ts';
import { MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { CONFIG_FILE_MAX_BYTES } from '../../../host/config/yaml-text.ts';
import { bootHost, type HostConfig, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { type DeclaredKind, declaredKinds, mcpReviewShapes, sweepTextOf } from '../host-config/real-schemas.ts';
import { recordingAdmission } from './fixtures.ts';

/** A hard bound, far above one linear read: the shapes this guards took 4–16 s at this size. */
const BOUND_MS = 1500;

const base = { version: '5.0.0', api: 5, kinds: [] } as const;
const gate = definePlugin({ ...base, id: 'gate', title: 'Gate', core: true, provides: { admission: AdmissionPort } });

const roots: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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

async function bootsWithinTheBound(kind: DeclaredKind, text: string): Promise<void> {
  const at = await homeWith(kind, text);
  const started = performance.now();
  const service = await boot(at, kind);
  expect(performance.now() - started).toBeLessThan(BOUND_MS);
  const status = service.status?.();
  const file = status?.files.find(entry => entry.path === kind.path);
  // Refused with its problems capped — or, for a kind whose schema takes any value there (a settings file), read.
  const issues = (status?.issues ?? []).filter(issue => issue.path === kind.path);
  if (file?.state === 'ok') expect(issues).toEqual([]);
  else {
    expect(file?.state).toBe('invalid');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(MAX_CONFIG_ISSUES + 1);
  }
}

describe('boot with a real kind written wrong at the size cap', () => {
  // The kernel's own file is declared by the host itself; every other kind an agent may name is booted here.
  const kinds = declaredKinds().filter(kind => kind.agentMayName && kind.plugin !== 'kernel' && kind.plugin !== 'gate');

  test('the kinds an agent may name are all here', () => {
    expect(kinds.map(kind => kind.path)).toContain('mcp/sweep.yaml');
    expect(kinds.length).toBeGreaterThanOrEqual(15);
  });

  for (const kind of kinds) {
    const [label, text] = sweepTextOf(kind, CONFIG_FILE_MAX_BYTES);
    test(`T-0032 ${kind.path} (${label}): boot answers in under ${BOUND_MS} ms, never fails`, async () => {
      await bootsWithinTheBound(kind, text);
    });
  }

  const mcp = declaredKinds().find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(CONFIG_FILE_MAX_BYTES)) {
    test(`T-0032 mcp/<name>.yaml, ${label}: boot answers in under ${BOUND_MS} ms, never fails`, async () => {
      if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
      await bootsWithinTheBound(mcp, text);
    });
  }
});
