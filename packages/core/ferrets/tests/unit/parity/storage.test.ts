import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import {
  AutoResumeDecide,
  type AutoResumeDecideInput,
  AutoResumeFile,
  AutoResumeSummaryFile,
  FerretsPort,
} from '../../../contract/index.ts';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { AUTO_RESUME_JOB } from '../../../daemon/modules/auto-resume.ts';
import manifest from '../../../manifest.ts';
import { host } from '../daemon/ferrets/route-fixture.ts';
import {
  effectFileName,
  FileSessionEffectLedger,
} from '../../../daemon/adapters/session/effects/file-session-effect-ledger.ts';
import { FileSessionEnvironmentStore } from '../../../daemon/adapters/session/lifecycle/index.ts';
import { OwnFolder } from '../../../daemon/adapters/session/sessions-root.ts';
import { FileResumeTurnStore } from '../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import type { RedactionScope } from '@ferretry/kernel/contract';
import type { FerretId, Runner, RunnerHandle, RunnerLook } from '../../../contract/index.ts';
import { FileLastSnapshotStore } from '../../../daemon/adapters/session/snapshot/file-last-snapshot-store.ts';
import { LastSnapshotCapture } from '../../../daemon/lib/session/snapshot/index.ts';
import {
  archiveWorld,
  finishFerret,
  HOUR_MS,
  pass,
  startFerret,
  tickArchive,
} from '../../support/daemon/archive-world.ts';

const fresh = async () => await host([], { harness: new FakeHarness(), runner: new FakeRunner() });

describe('storage parity', () => {
  test('F-0232 a started ferret lands in state/ferrets/names.json as { format: 1, claims: [{ callsign, ownerId }] }', async () => {
    const h = await fresh();
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-names-1' },
      body: { folder: '/work/a', name: 'wren' },
    });
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    const stored = JSON.parse(h.state('ferrets').files.get('names.json') as string) as {
      format: number;
      claims: { callsign: string; ownerId: string }[];
    };
    expect(stored.format).toBe(1);
    expect(stored.claims.map(({ callsign, ownerId }) => ({ callsign, ownerId }))).toEqual([
      { callsign: 'wren', ownerId: id },
    ]);
    expect(manifest.data.state.map(file => file.path)).toContain('names.json');
  });

  test('F-0349 the first system callsign for a prefix lands in state/ferrets/system-callsigns.json as { learning: 1 }', async () => {
    const h = await fresh();
    expect(await h.provided(FerretsPort).systemCallsign?.('learning')).toBe('learning-000001');
    const stored = JSON.parse(h.state('ferrets').files.get('system-callsigns.json') as string) as Record<
      string,
      number
    >;
    expect(stored).toEqual({ format: 1, learning: 1 });
    expect(manifest.data.state.map(file => file.path)).toContain('system-callsigns.json');
  });
});

describe('session-private files parity (the internal sessions root, state/ferrets/sessions/<ferret>/)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const FERRET = parseSessionId('mw7bp88g-50e00159');
  const mode = async (path: string) => (await lstat(path)).mode & 0o777;
  const sessionsRoot = async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-parity-sessions-`);
    dirs.push(parent);
    return { parent, ...(await diskSessionsRoot(parent, FERRET)) };
  };

  test('F-0094 environment.json is a flat string map the environment store publishes 0600 in the ferret folder, and reads back only for the launch', async () => {
    const { root, folder } = await sessionsRoot();
    const store = new FileSessionEnvironmentStore(root, FERRET);
    await store.write(FERRET, { FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });
    expect(String(store.file(FERRET))).toBe(`${folder}/environment.json`);
    expect(await mode(`${folder}/environment.json`)).toBe(0o600);
    expect(await store.read(FERRET)).toEqual({ FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });
  });

  test('F-0324 FY_HOME/state/ferrets/sessions/{ferret}/environment.json: the environment lives under the sessions root, in a 0700 folder', async () => {
    const { parent, root, folder } = await sessionsRoot();
    await new FileSessionEnvironmentStore(root, FERRET).write(FERRET, { A: 'b' });
    expect(folder).toBe(`${parent}/home/state/ferrets/sessions/${FERRET}`);
    expect(await mode(folder)).toBe(0o700);
    expect(await mode(`${parent}/home/state/ferrets/sessions`)).toBe(0o700);
  });

  test('F-0323 FY_HOME/state/ferrets/sessions/{ferret}/effects/{effectFileName}.json: an effect record is a 0600 file named by the hash of its id', async () => {
    const { root, folder } = await sessionsRoot();
    const ledger = new FileSessionEffectLedger(root, FERRET);
    const key = { sessionId: FERRET, effectId: '../../etc/fixture' };
    expect(await ledger.begin(key, 'fingerprint', '2026-11-08T10:00:00.000Z')).toBe('perform');
    expect(String(ledger.file(key))).toBe(`${folder}/effects/${effectFileName(key.effectId)}.json`);
    expect(await mode(`${folder}/effects/${effectFileName(key.effectId)}.json`)).toBe(0o600);
    expect(await mode(`${folder}/effects`)).toBe(0o700);
  });

  test('F-0002 who a turn is from is FY_HOME/state/ferrets/sessions/{ferret}/turns/turn-NNN.by.json, beside the document and 0600', async () => {
    const { root, folder } = await sessionsRoot();
    const file = await new FileResumeTurnStore(root, FERRET).writeTurn(FERRET, 2, 'Again.\n', { kind: 'owner' });
    expect(file).toBe(`${folder}/turns/turn-002.md`);
    expect(JSON.parse(await readFile(`${folder}/turns/turn-002.by.json`, 'utf8'))).toEqual({ kind: 'owner' });
    expect(await mode(`${folder}/turns/turn-002.by.json`)).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('Again.\n');
  });

  for (const [row, marker] of [
    ['F-0305 F-0322', 'done'],
    ['F-0305 F-0329', 'needs-help'],
    ['F-0305', 'process-exit'],
  ] as const)
    test(`${row} FY_HOME/state/ferrets/sessions/{ferret}/${marker}.marker is cleared before every relaunch`, async () => {
      const { root, folder } = await sessionsRoot();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(`${folder}/${marker}.marker`, `${marker}\n`);
      await new FileResumeTurnStore(root, FERRET).clearMarkers(FERRET);
      await expect(lstat(`${folder}/${marker}.marker`)).rejects.toThrow();
    });

  test('F-0326 FY_HOME/state/ferrets/sessions/{ferret}/last-snapshot.txt: the screen a stop looked at, masked, 0600', async () => {
    const { root, folder } = await sessionsRoot();
    const value = 'sk-parity-fixture-value';
    const look: RunnerLook = { frame: 'f', working: false, atPrompt: true, permission: false, status: `> ${value}` };
    await new LastSnapshotCapture({
      store: id => new FileLastSnapshotStore(root, id),
      redaction: {
        read: async <T>(fn: (scope: RedactionScope) => T | Promise<T>) => {
          const text = (s: string) => s.split(value).join('*'.repeat(value.length));
          return await fn({ text, cells: grid => grid, lines: lines => lines.map(text) });
        },
      },
      sleep: async () => await new Promise<void>(() => {}),
      log: { warn: () => {} },
    }).capture(FERRET as unknown as FerretId, { look: async () => look } as unknown as Runner, '%1' as RunnerHandle);
    expect(await readFile(`${folder}/last-snapshot.txt`, 'utf8')).toBe(`> ${'*'.repeat(value.length)}`);
    expect(await mode(`${folder}/last-snapshot.txt`)).toBe(0o600);
    expect(await mode(folder)).toBe(0o700);
  });

  test('F-0303 the per-ferret folder is state/ferrets/sessions/{ferret}, held 0700 when the ferret starts even if it was wider', async () => {
    const { root, folder } = await sessionsRoot();
    await mkdir(folder, { recursive: true, mode: 0o755 });
    await chmod(folder, 0o755);
    await new OwnFolder(root).ensure();
    expect(await mode(folder)).toBe(0o700);
  });
});

describe('archive parity (U6)', () => {
  test('F-0220 the archive is one document, state/ferrets/archive.json, naming each archived ferret and when it left', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    const stored = JSON.parse(h.state('ferrets').files.get('archive.json') as string) as {
      format: number;
      sessions: Record<string, { archivedAt: string; name?: string }>;
    };
    expect(stored.format).toBe(1);
    expect(Object.keys(stored.sessions)).toEqual([id]);
    expect(stored.sessions[id]?.name).toBe('aniya');
    expect(stored.sessions[id]?.archivedAt).toBe(h.clock.now());
    await h.stop();
  });
});

describe('auto-resume state parity (W2-a: FY_HOME/auto-resume*.json moved under state/ferrets/)', () => {
  const runtimesAnswering = (seen: (input: AutoResumeDecideInput) => void) =>
    implementDaemon(
      definePlugin({
        id: 'runtimes',
        title: 'Runtimes (fake)',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { takes: [{ hook: AutoResumeDecide }] },
      }),
      {
        build: () => ({
          hooks: {
            'auto-resume.decide': (input: AutoResumeDecideInput) => {
              seen(input);
              return { allow: true };
            },
          },
        }),
      },
    );

  test('F-0109 the ferrets a host restart took down are in state/ferrets/auto-resume.json before any is resumed, and removed once worked off', async () => {
    let h!: Awaited<ReturnType<typeof host>>;
    const owedWhenAsked: (string | undefined)[] = [];
    const runner = new FakeRunner();
    h = await host([], {
      harness: new FakeHarness(),
      runner,
      plugins: [
        runtimesAnswering(input => {
          if (input.ask === 'runtime') owedWhenAsked.push(h.state('ferrets').raw(AutoResumeFile));
        }),
      ],
    });
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-auto-resume-1' },
      body: { folder: '/work/a', name: 'wren', runtime: 'claude-work' },
    });
    const { id } = started.json<{ id: string }>();
    await h.settle();
    runner.reboot();
    h = await h.restart();
    await h.runJob(AUTO_RESUME_JOB);
    await h.settle();
    expect(owedWhenAsked).toHaveLength(1);
    const owed = JSON.parse(owedWhenAsked[0] ?? '{}') as {
      format: number;
      candidates: { id: string; status: string }[];
    };
    expect(owed.format).toBe(1);
    expect(owed.candidates.map(candidate => [candidate.id, candidate.status])).toEqual([[id, 'running']]);
    expect(h.state('ferrets').raw(AutoResumeFile)).toBeUndefined();
    expect(manifest.data.state.map(file => file.path)).toContain('auto-resume.json');
    await h.stop();
  });

  test('F-0108 what the last pass did lands in state/ferrets/auto-resume-summary.json as { format: 1, at, resumed, skipped }', async () => {
    const runner = new FakeRunner();
    let h = await host([], { harness: new FakeHarness(), runner, plugins: [runtimesAnswering(() => undefined)] });
    await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-auto-resume-2' },
      body: { folder: '/work/a', name: 'wren', runtime: 'claude-work' },
    });
    await h.settle();
    runner.reboot();
    h = await h.restart();
    await h.runJob(AUTO_RESUME_JOB);
    await h.settle();
    const stored = JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}') as Record<string, unknown>;
    expect(stored).toEqual({ format: 1, at: h.clock.now(), resumed: 1, skipped: [] });
    expect(manifest.data.state.map(file => file.path)).toContain('auto-resume-summary.json');
    await h.stop();
  });
});
