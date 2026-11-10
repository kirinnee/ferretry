import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { state } from '@ferretry/kernel/host';
import { diskSessionsRoot, MemoryStateFolder } from '@ferretry/kernel/testing';
import { FakeHarness, FakeRunner, ferretId } from '../../../contract/testing/index.ts';
import {
  AgentPinsDocumentSchema,
  AgentPinsFile,
  ArchiveFile,
  AutoResumeDecide,
  type AutoResumeDecideInput,
  AutoResumeFile,
  AutoResumeSummaryFile,
  FerretConfigDocumentSchema,
  FerretConfigFile,
  FerretHistoryEventSchema,
  FerretHistoryFiles,
  FerretIndexFile,
  FerretPinsDocumentSchema,
  FerretPinsFile,
  FerretsPort,
  FerretStateDocumentSchema,
  FerretStateFile,
  FerretSummaryFiles,
  ForkFiles,
  FERRET_SESSIONS_FOLDER,
  HandoverFiles,
  LimitsConfigFile,
  MoveInflightFiles,
  TransferPlanFiles,
  WorktreesFile,
} from '../../../contract/index.ts';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { AUTO_RESUME_JOB } from '../../../daemon/modules/auto-resume.ts';
import manifest from '../../../manifest.ts';
import { as, host, portConsumer, record } from '../daemon/ferrets/route-fixture.ts';
import { AT as forkAt, command as forkCommand, plan as forkPlan } from '../daemon/forks/fixtures.ts';
import { handoverReceiptFor } from '../../support/daemon/parity-fj-docs.ts';
import { memoryStorage, RecordingLog, sessionState } from '../../support/daemon/storage.ts';
import {
  effectFileName,
  FileSessionEffectLedger,
} from '../../../daemon/adapters/session/effects/file-session-effect-ledger.ts';
import { FileSessionEnvironmentStore } from '../../../daemon/adapters/session/lifecycle/index.ts';
import { OwnFolder } from '../../../daemon/adapters/session/sessions-root.ts';
import { FileResumeTurnStore } from '../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { FileHandoverReceiptStore } from '../../../daemon/adapters/moves/handover/file-handover-receipt-store.ts';
import { StateMoveReportStore } from '../../../daemon/adapters/moves/state-move-report.ts';
import { FileSessionTransferTargetPlanStore } from '../../../daemon/adapters/transfer/plan-store.ts';
import { StateManagedWorktreeRegistry } from '../../../daemon/adapters/worktrees/index.ts';
import {
  forkReceiptName,
  StateSessionForkReceiptStore,
} from '../../../daemon/adapters/forks/state-session-fork-receipt-store.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { sessionForkFingerprint } from '../../../daemon/lib/forks/identity.ts';
import { claimSessionForkReceipt, parseSessionForkReceipt } from '../../../daemon/lib/forks/receipt.ts';
import { deriveTransferPlanId } from '../../../daemon/lib/transfer/prepare.ts';
import { type ManagedWorktree, withManagedWorktree } from '../../../daemon/lib/worktrees/index.ts';
import type { RedactionScope } from '@ferretry/kernel/contract';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
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

const fresh = async () =>
  await host([], { harness: new FakeHarness(), runner: new FakeRunner(), plugins: [portConsumer('lessons')] });

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
    expect(await h.provided(FerretsPort, 'lessons').systemCallsign?.('learning')).toBe('learning-000001');
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

  // Each title names F-0305 literally (the tick gate reads the title, not a template). The done and needs-help markers
  // are also the files of F-0322 / F-0329; those rows stay open (nothing writes the marker yet), so their ids are
  // deliberately NOT in these titles.
  async function markerIsCleared(marker: string): Promise<void> {
    const { root, folder } = await sessionsRoot();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(`${folder}/${marker}.marker`, `${marker}\n`);
    await new FileResumeTurnStore(root, FERRET).clearMarkers(FERRET);
    await expect(lstat(`${folder}/${marker}.marker`)).rejects.toThrow();
  }

  test('F-0305 FY_HOME/state/ferrets/sessions/{ferret}/done.marker is cleared before every relaunch', async () => {
    await markerIsCleared('done');
  });

  test('F-0305 FY_HOME/state/ferrets/sessions/{ferret}/needs-help.marker is cleared before every relaunch', async () => {
    await markerIsCleared('needs-help');
  });

  test('F-0305 FY_HOME/state/ferrets/sessions/{ferret}/process-exit.marker is cleared before every relaunch', async () => {
    await markerIsCleared('process-exit');
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

  test('F-0326 last-snapshot.txt: a value wrapped across two pane rows reaches the file in neither half', async () => {
    const { root, folder } = await sessionsRoot();
    const value = 'ghp_FAKEPARITYwrapAAAABBBBCCCCDDDDEEEE12';
    const [head, tail] = [value.slice(0, 20), value.slice(20)];
    // capture-pane (no -J) splits a line wider than the pane: the value starts at column 60 of an 80-column row.
    const status = `${'.'.repeat(60)}${head}\n${tail}\n> `;
    const look: RunnerLook = { frame: 'f', working: false, atPrompt: true, permission: false, status };
    await new LastSnapshotCapture({
      store: id => new FileLastSnapshotStore(root, id),
      redaction: new FakeRedaction(new Map([['GH_TOKEN' as SecretName, value]])),
      sleep: async () => await new Promise<void>(() => {}),
      log: { warn: () => {} },
    }).capture(FERRET as unknown as FerretId, { look: async () => look } as unknown as Runner, '%1' as RunnerHandle);
    const kept = await readFile(`${folder}/last-snapshot.txt`, 'utf8');
    expect(kept).not.toContain(head);
    expect(kept).not.toContain(tail);
    expect(kept).toBe(`${'.'.repeat(60)}${'*'.repeat(head.length)}\n${'*'.repeat(tail.length)}\n> `);
  });

  test('F-0303 the per-ferret folder is state/ferrets/sessions/{ferret}, held 0700 when the ferret starts even if it was wider', async () => {
    const { root, folder } = await sessionsRoot();
    await mkdir(folder, { recursive: true, mode: 0o755 });
    await chmod(folder, 0o755);
    await new OwnFolder(root).ensure();
    expect(await mode(folder)).toBe(0o700);
  });

  test('F-0299 the sessions root is FY_HOME/state/ferrets/sessions (v4 state/sessions): one 0700 folder under which every ferret has its private folder', async () => {
    const { parent, root, folder } = await sessionsRoot();
    await new FileSessionEnvironmentStore(root, FERRET).write(FERRET, { A: 'b' });
    expect(FERRET_SESSIONS_FOLDER).toBe('state/ferrets/sessions');
    expect(folder).toBe(`${parent}/home/${FERRET_SESSIONS_FOLDER}/${FERRET}`);
    expect(await mode(`${parent}/home/${FERRET_SESSIONS_FOLDER}`)).toBe(0o700);
    expect(manifest.permissions?.roots).toContain('sessions');
  });
});

describe('configuration parity (F-0166 F-0372)', () => {
  test('F-0166 F-0372 limits.yaml is the Ferrets configuration file limits.yaml (FY_HOME/config/limits.yaml), read fresh on every call', async () => {
    const wren = ferretId('wren');
    const h = await host([record('wren')], { config: { 'limits.yaml': { agentControl: { browsers: false } } } });
    expect(await h.provided(FerretsPort).agentControl(wren)).toEqual({
      terminals: true,
      browsers: false,
      files: true,
      ferretrySettings: false,
      pageScripts: false,
    });
    h.setConfig('limits.yaml', { agentControl: { ferretrySettings: true } });
    expect(await h.provided(FerretsPort).agentControl(wren)).toEqual({
      terminals: true,
      browsers: true,
      files: true,
      ferretrySettings: true,
      pageScripts: false,
    });
    expect(LimitsConfigFile.file).toBe('limits.yaml');
    expect(manifest.data.config.map(file => (file as { file?: string }).file)).toContain('limits.yaml');
    await h.stop();
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

describe('ferret documents parity (the v4 session folder is state/ferrets/<ferret>/ in 5.0)', () => {
  const asDocument = (text: string | undefined) => {
    const { format, ...body } = JSON.parse(text ?? 'null') as { format: number } & Record<string, unknown>;
    return { format, firstKey: Object.keys(JSON.parse(text ?? '{}') as object)[0], body };
  };
  const started = async () => {
    const h = await fresh();
    const answer = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-docs-1' },
      body: { folder: '/work/a', name: 'wren' },
    });
    expect(answer.status).toBe(201);
    return { h, id: answer.json<{ id: string }>().id };
  };
  const finished = async () => {
    const world = await started();
    const done = await world.h.request('POST', `/v1/ferrets/${world.id}/signal`, {
      body: { kind: 'done', message: 'shipped the thing' },
      ...as(world.id),
    });
    expect(done.status).toBe(200);
    return world;
  };

  test('F-0321 the session configuration is state/ferrets/{ferret}/config.json, a strict format-1 document held 0600', async () => {
    const { h, id } = await started();
    const stored = asDocument(h.state('ferrets').files.get(`${id}/config.json`));
    expect(stored.format).toBe(1);
    expect(stored.firstKey).toBe('format');
    const config = FerretConfigDocumentSchema.parse(stored.body);
    expect(config).toMatchObject({ id, name: 'wren', teammate: 'wren', cwd: '/work/a' });
    expect(FerretConfigFile.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/config.json');
    await h.stop();
  });

  test('F-0334 the session state is state/ferrets/{ferret}/state.json, a strict format-1 document, and a finished ferret says stopped', async () => {
    const { h, id } = await finished();
    const stored = asDocument(h.state('ferrets').files.get(`${id}/state.json`));
    expect(stored.format).toBe(1);
    expect(stored.firstKey).toBe('format');
    expect(FerretStateDocumentSchema.parse(stored.body)).toMatchObject({ id, status: 'stopped', turn: 0 });
    expect(FerretStateFile.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/state.json');
    await h.stop();
  });

  test('F-0325 the session journal is state/ferrets/{ferret}/history.jsonl (v4 events.jsonl): one strict event per line, sequence rising from 1', async () => {
    const { h, id } = await finished();
    const lines = (h.state('ferrets').files.get(`${id}/history.jsonl`) ?? '').split('\n').filter(line => line !== '');
    const stamped = lines.map(line => JSON.parse(line) as { format: number });
    expect(stamped.every(line => line.format === 1)).toBe(true);
    const events = stamped.map(({ format: _format, ...event }) => FerretHistoryEventSchema.parse(event));
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events.every(event => event.sessionId === id)).toBe(true);
    expect(events.map(event => event.type)).toContain('session.completed');
    expect([...h.state('ferrets').files.keys()].some(key => key.endsWith('events.jsonl'))).toBe(false);
    expect(manifest.data.state.map(file => file.path)).toContain('*/history.jsonl');
    await h.stop();
  });

  test('F-0070 F-0219 the owner pins are state/ferrets/agent-pins.json as { format: 1, pins: [{ sessionId, pinnedAt }] }, emptied by an unpin', async () => {
    const { h, id } = await started();
    expect((await h.request('POST', `/v1/ferrets/${id}/pin`, {})).status).toBe(200);
    const pinned = asDocument(h.state('ferrets').files.get('agent-pins.json'));
    expect(pinned.format).toBe(1);
    expect(AgentPinsDocumentSchema.parse(pinned.body).pins).toEqual([{ sessionId: id, pinnedAt: h.clock.now() }]);
    expect((await h.request('POST', `/v1/ferrets/${id}/unpin`, {})).status).toBe(200);
    expect(asDocument(h.state('ferrets').files.get('agent-pins.json')).body).toEqual({ pins: [] });
    expect(AgentPinsFile.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('agent-pins.json');
    await h.stop();
  });

  test("F-0330 F-0394 a ferret's note pins are state/ferrets/{ferret}/pins.json, separate from the owner pins, a format-1 document held 0600", async () => {
    const { h, id } = await started();
    const added = await h.request('POST', `/v1/ferrets/${id}/pins`, {
      body: { action: 'add', kind: 'note', text: 'remember the plan' },
    });
    expect(added.status).toBe(200);
    const stored = asDocument(h.state('ferrets').files.get(`${id}/pins.json`));
    expect(stored.format).toBe(1);
    const pins = FerretPinsDocumentSchema.parse(stored.body).pins;
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ kind: 'note', text: 'remember the plan', by: 'human' });
    expect(h.state('ferrets').files.has('agent-pins.json')).toBe(false);
    expect(FerretPinsFile.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/pins.json');
    await h.stop();
  });

  test('F-0336 signal done writes the summary to state/ferrets/{ferret}/summary.md, as the ferret wrote it, held 0600', async () => {
    const { h, id } = await finished();
    expect(new TextDecoder().decode(h.state('ferrets').bytes.get(`${id}/summary.md`))).toBe('shipped the thing\n');
    expect(FerretSummaryFiles.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/summary.md');
    await h.stop();
  });

  test('F-0335 the summary a pack result reads is FerretsPort.summary: the finished ferret summary.md, and nothing for a ferret still running', async () => {
    const running = await started();
    expect(await running.h.provided(FerretsPort).summary(running.id as FerretId)).toBeUndefined();
    await running.h.stop();
    const { h, id } = await finished();
    expect(await h.provided(FerretsPort).summary(id as FerretId)).toBe('shipped the thing\n');
    await h.stop();
  });

  test('F-0332 F-0333 the session-version marker is gone: every JSON document carries its own format first, and no marker file is written', async () => {
    const { h, id } = await finished();
    const files = h.state('ferrets').files;
    const documents = [...files.entries()].filter(([key]) => !key.endsWith('.jsonl'));
    expect(documents.length).toBeGreaterThan(5);
    for (const [key, text] of documents) expect([key, text.startsWith('{"format":1')]).toEqual([key, true]);
    const everyFile = [...files.keys(), ...h.state('ferrets').bytes.keys()];
    expect(everyFile.some(key => key.includes('session-version'))).toBe(false);
    expect(everyFile).toContain(`${id}/config.json`);
    expect(manifest.data.state.every(file => file.format === 1)).toBe(true);
    await h.stop();
  });
});

describe('session folder enumeration parity (F-0300)', () => {
  test('F-0300 every state/ferrets/{entry} folder holding a session document is a session, and a stranger folder is reported, not followed', async () => {
    const { storage, folder } = await memoryStorage();
    const first = parseSessionId('mw7bp88g-50e00159');
    const second = parseSessionId('mw7bp88h-60e00160');
    await storage.writeState(first, sessionState(first));
    await storage.writeState(second, sessionState(second));
    folder.files.set('Not A Session!/state.json', JSON.stringify({ format: 1, ...sessionState('stranger') }));
    expect([...folder.files.keys()].sort()).toEqual([
      'Not A Session!/state.json',
      `${first}/state.json`,
      `${second}/state.json`,
    ]);
    const rebuilt = await storage.rebuildIndex();
    expect(rebuilt.sessionCount).toBe(2);
    expect(rebuilt.problems.map(problem => problem.message)).toEqual(['invalid session directory "Not A Session!"']);
    expect(await storage.sessionIdsOnDisk()).toEqual([first, second]);
    await storage.close();
  });
});

describe('typed state files parity (F rows: handover, forks, transfer plan, move report, worktrees)', () => {
  const SOURCE = 'source-1';
  const REQUEST = 'req-1';
  const handoverReceipt = handoverReceiptFor;

  test('F-0302 F-0366 the handover receipt of a predecessor is state/ferrets/{source}/handover.json, a format-1 document', async () => {
    const folder = new MemoryStateFolder();
    const store = new FileHandoverReceiptStore(folder.port([HandoverFiles]));
    await store.write(handoverReceipt(SOURCE, REQUEST));
    expect(HandoverFiles.path).toBe('*/handover.json');
    expect([...folder.files.keys()]).toEqual([`${SOURCE}/handover.json`]);
    const stored = JSON.parse(folder.raw(HandoverFiles, SOURCE) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored)[0]).toBe('format');
    expect(stored).toMatchObject({ format: 1, sourceSessionId: SOURCE, requestId: REQUEST, phase: 'requested' });
    expect(await store.read(SOURCE)).toEqual(handoverReceipt(SOURCE, REQUEST));
    expect(manifest.data.state.map(file => file.path)).toContain('*/handover.json');
  });

  test('F-0301 the open handovers are found by listing every ferret folder that holds a handover.json, a folder without one is not listed', async () => {
    const folder = new MemoryStateFolder();
    const store = new FileHandoverReceiptStore(folder.port([HandoverFiles]));
    await store.write(handoverReceipt('source-a', 'req-a'));
    await store.write(handoverReceipt('source-b', 'req-b'));
    folder.files.set('source-c/state.json', JSON.stringify({ format: 1 }));
    expect([...(await store.pendingSourceSessionIds())].sort()).toEqual(['source-a', 'source-b']);
  });

  test('F-0250 a fork receipt is state/ferrets/forks/{planId}.json (the plan id derived from the source and the request), claimed once', async () => {
    const folder = new MemoryStateFolder();
    const store = new StateSessionForkReceiptStore(folder.port([ForkFiles]));
    const key = { sourceSessionId: SOURCE, requestId: REQUEST };
    const receipt = claimSessionForkReceipt({
      key,
      requestFingerprint: sessionForkFingerprint(forkCommand()),
      targetSessionId: 'target-1',
      plan: forkPlan({ sourceSessionId: SOURCE, requestId: REQUEST }),
      at: forkAt,
    });
    await store.claim(receipt);
    const planId = deriveTransferPlanId(SOURCE, REQUEST);
    expect(forkReceiptName(key)).toBe(planId);
    expect([...folder.files.keys()]).toEqual([`forks/${planId}.json`]);
    expect(folder.raw(ForkFiles, planId)?.startsWith('{"format":1,')).toBe(true);
    expect(parseSessionForkReceipt(await store.read(key), key)).toEqual(receipt);
    expect(ForkFiles.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('forks/*.json');
  });

  test('F-0339 the frozen transfer plan sits beneath the new ferret as state/ferrets/{target}/transfer-plan.json, held 0600, installed once', async () => {
    const folder = new MemoryStateFolder();
    const store = new FileSessionTransferTargetPlanStore(folder.port([TransferPlanFiles]));
    const target = parseSessionId('target-1');
    const plan = forkPlan({ sourceSessionId: SOURCE, requestId: REQUEST });
    expect((await store.install(target, plan)).status).toBe('installed');
    expect((await store.install(target, plan)).status).toBe('present');
    expect([...folder.files.keys()]).toEqual(['target-1/transfer-plan.json']);
    expect(folder.raw(TransferPlanFiles, target)?.startsWith('{"format":1,')).toBe(true);
    expect(await store.load(target)).toEqual(plan);
    expect(TransferPlanFiles.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/transfer-plan.json');
  });

  test('F-0328 the move report (v4 migration-inflight.md) is state/ferrets/{ferret}/move-inflight.md, written in two halves and held 0600', async () => {
    const folder = new MemoryStateFolder();
    const store = new StateMoveReportStore(folder.port([MoveInflightFiles]));
    const id = parseSessionId('session-1');
    const path = await store.write(id, '# Move in-flight report\n');
    await store.append(id, 'Outcome: moved.\n');
    expect(path.endsWith('session-1/move-inflight.md')).toBe(true);
    expect([...folder.bytes.keys()]).toEqual(['session-1/move-inflight.md']);
    expect(new TextDecoder().decode(folder.rawBytes(MoveInflightFiles, id))).toBe(
      '# Move in-flight report\nOutcome: moved.\n',
    );
    expect(MoveInflightFiles.mode).toBe(0o600);
    expect(manifest.data.state.map(file => file.path)).toContain('*/move-inflight.md');
  });

  test('F-0363 the managed worktree registry is state/ferrets/worktrees.json as { format: 1, worktrees, intents }', async () => {
    const folder = new MemoryStateFolder();
    const registry = new StateManagedWorktreeRegistry(folder.port([WorktreesFile]));
    const checkout: ManagedWorktree = {
      version: 1,
      path: '/managed/repo/feat-one',
      branch: 'feat/one',
      repositoryRoot: '/work/ferretry',
      commonDir: '/work/ferretry/.git',
      gitDir: '/work/ferretry/.git/worktrees/feat-one',
      ownershipToken: 'ownership-token-0001',
      createdAt: '2026-08-04T00:00:00.000Z',
      initialHead: 'a'.repeat(40),
      branchPreexisted: false,
      sourceCwd: '/work/ferretry/packages/cli',
      relativeCwd: 'packages/cli',
    };
    await registry.write(state => withManagedWorktree(state, checkout));
    expect([...folder.files.keys()]).toEqual(['worktrees.json']);
    const stored = JSON.parse(folder.raw(WorktreesFile) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored)[0]).toBe('format');
    expect(stored).toEqual({ format: 1, worktrees: [checkout], intents: [] });
    expect((await registry.read()).worktrees).toEqual([checkout]);
    expect(manifest.data.state.map(file => file.path)).toContain('worktrees.json');
  });
});

describe('the session index parity (F-0256 F-0257 F-0258)', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  test('F-0256 F-0257 F-0258 the session index is the cache state/ferrets/index.sqlite (v4 state/index/sessions.sqlite), 0600, its -wal and -shm beside it, all removed together', async () => {
    const home = await mkdtemp(`${tmpdir()}/fy-parity-index-`);
    homes.push(home);
    const port = state.createStatePort({
      home,
      pluginId: 'ferrets',
      files: [FerretHistoryFiles, FerretConfigFile, FerretStateFile, FerretIndexFile, ArchiveFile],
      fs: state.createNodeHostFs(),
    });
    const storage = new DaemonStorage(port, { now: () => '2026-11-08T10:00:00.000Z' }, new RecordingLog());
    await storage.loadArchive();
    const id = parseSessionId('mw7bp88g-50e00159');
    await storage.writeState(id, sessionState(id));
    await storage.rebuildIndex();
    const index = `${home}/state/ferrets/index.sqlite`;
    const mode = async (path: string) => (await lstat(path)).mode & 0o777;
    expect(await mode(index)).toBe(0o600);
    for (const sidecar of ['-wal', '-shm']) await expect(lstat(`${index}${sidecar}`)).resolves.toBeDefined();
    const reader = new Database(index, { readonly: true });
    try {
      expect(reader.query('PRAGMA user_version').get()).toEqual({ user_version: FerretIndexFile.format });
      expect(reader.query('SELECT id FROM sessions').all()).toEqual([{ id }]);
    } finally {
      reader.close();
    }
    await expect(lstat(`${home}/state/index/sessions.sqlite`)).rejects.toThrow();
    expect(FerretIndexFile.store).toBe('sqlite-cache');
    await storage.close();
    await port.remove(FerretIndexFile);
    for (const suffix of ['', '-wal', '-shm']) await expect(lstat(`${index}${suffix}`)).rejects.toThrow();
  });
});
