/**
 * Parity rows J-0001, J-0260 (docs/design/rebuild-parity.tsv): the turn watch, mounted in Ferrets (U4); J-0240: the live
 * readout and the transcript signal on `GET /v1/events`, mounted in Ferrets (U5).
 *
 * Parity rows J-0002, J-0015, J-0057, J-0069, J-0084, J-0107, J-0239, J-0245, J-0247, J-0259: the auto-resume job, the
 * agenda's turn hook, pack starts, the handover reconcile loop, the event stream's idle proof and the document read.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { queryFrom, type SocketDownstream, type StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { state } from '@ferretry/kernel/host';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '@ferretry/core-gate/contract/testing';
import type { ChildEnvironment, SecretName } from '@ferretry/core-vault/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { CallStanding, FerretId, HookDecision } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import type { Result } from '@ferretry/std';
import manifest from '../../../manifest.ts';
import {
  AutoResumeDecide,
  type AutoResumeDecideInput,
  AutoResumeSummaryFile,
  FerretChanged,
  type FerretChangedPayload,
  FerretHistoryFiles,
  FerretIndexFile,
  HandoverFiles,
  type PackId,
  FerretStateFile,
  FerretsPort,
  Harnesses,
  type RunnerHandle,
  type HarnessTailRecord,
  type HarnessTranscriptStamp,
  type RunnerLook,
  Runners,
  StartDecide,
} from '../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import ferrets, { TURN_WATCH_JOB } from '../../../daemon/index.ts';
import { FileHandoverReceiptStore } from '../../../daemon/adapters/moves/handover/file-handover-receipt-store.ts';
import { fleetEventsAccept, HistoryEventSource } from '../../../daemon/modules/fleet-events.ts';
import { AUTO_RESUME_JOB } from '../../../daemon/modules/auto-resume.ts';
import { type SessionHandoverNeeds, sessionHandoverModule } from '../../../daemon/modules/session-handover.ts';
import type { SessionDirectorySubsystem } from '../../../daemon/lib/session/directory/subsystem.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../daemon/lib/storage/journal.ts';
import type { SessionId } from '../../../daemon/lib/session-id.ts';
import { sessionHandoverNeedsForTest } from '../daemon/modules/session-handover/fixture.ts';
import { fakePacks, host as ferretsHost } from '../daemon/ferrets/route-fixture.ts';
import { handoverReceiptFor } from '../../support/daemon/parity-fj-docs.ts';
import { memoryStorage, sessionConfig, sessionState } from '../../support/daemon/storage.ts';
import { generatedFleet, restartWithCacheLost, sessionIdAt } from '../../support/daemon/index-rebuild-world.ts';
import { INDEX_REBUILD_JOB } from '../../../daemon/modules/index-rebuild.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { QUESTION_FILE_VARIABLE } from '../../../daemon/lib/ferrets/service.ts';
import { ARCHIVE_PASS_JOB } from '../../../daemon/modules/archive.ts';
import {
  archiveWorld,
  archived,
  finishFerret,
  HOUR_MS,
  pass,
  startFerret,
  tickArchive,
} from '../../support/daemon/archive-world.ts';

const SECRET = 'sk-live-u4prompt';

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
/** A listener with a real plugin's shape: Conversation hears `ferret.changed` this way (its `turn.ended`). */
const listenerPlugin = (heard: FerretChangedPayload[], id = 'conversation') =>
  implementDaemon(
    definePlugin({
      id,
      title: 'Conversation (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: FerretChanged }] },
    }),
    { build: () => ({ hooks: { 'ferret.changed': (payload: FerretChangedPayload) => void heard.push(payload) } }) },
  );

/** The Vault fake, keeping each launch's environment as Ferrets handed it (names and fixture paths only). */
class RecordingVault extends FakeVault {
  readonly asked: Readonly<Record<string, string>>[] = [];
  override async childEnvironment(
    ferret: FerretId,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> {
    this.asked.push(env);
    return await super.childEnvironment(ferret, env);
  }
}

/** A stand-in for Packs (its real id) that admits every helper on `start.decide`. */
const admitting = () =>
  implementDaemon(
    definePlugin({
      id: 'packs',
      title: 'Packs (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { ferrets: FerretsPort },
      hooks: { takes: [{ hook: StartDecide }] },
    }),
    { build: () => ({ hooks: { 'start.decide': async (): Promise<HookDecision> => ({ allow: true }) } }) },
  );

async function host(standing: () => CallStanding = () => ownerStanding(), more: ReturnType<typeof admitting>[] = []) {
  const runner = new FakeRunner();
  const heard: FerretChangedPayload[] = [];
  const vault = new RecordingVault();
  const harness = new FakeHarness();
  const h = await testHost({
    plugins: [ferrets, harnessPlugin(harness), runnerPlugin(runner), listenerPlugin(heard), ...more],
    gate: new StandInAdmission(standing),
    fakes: { gate: new FakeGate(), vault, asks: new FakeAsks() },
    secrets: [SECRET],
  });
  return { h, runner, heard, vault, harness };
}

const start = async (h: TestHost, name: string): Promise<FerretId> => {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { name, folder: `/work/${name}` },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: FerretId }>().id;
};

/** Moves the driven clock one 2 s tick and lets the tick (one pane per turn of the loop) run to its end. */
async function tick(h: TestHost): Promise<void> {
  await h.clock.advance(2_000);
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(0);
  }
  await h.settle();
}

/** Moves the clock `by` ms and lets every read the moved timers started run to its end. */
async function advance(h: TestHost, by: number): Promise<void> {
  await h.clock.advance(by);
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(0);
  }
  await h.settle();
}

const STAMP = (file: string, size: number): HarnessTranscriptStamp => ({ file, size, mtimeMs: size });
const working = (frame: string): RunnerLook => ({ frame, working: true, atPrompt: false, permission: false });

describe('the turn watch (U4, ruling #27 Q3: mounted in Ferrets)', () => {
  test('J-0001 the turn watch is armed by a job once the daemon serves, and not before', async () => {
    const { h, runner } = await host();
    const id = await start(h, 'aniya');
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    expect(h.jobIds()).toContain(TURN_WATCH_JOB);

    await tick(h);
    expect(runner.looked).toEqual([]);

    await h.runJob(TURN_WATCH_JOB);
    await tick(h);
    expect(runner.looked).toContain(handle);
    await h.stop();
  });

  test('J-0260 a turn the pane shows moves the ferret working/idle and says ferret.changed {change: state}', async () => {
    const { h, runner, heard, harness } = await host();
    const id = await start(h, 'bodhi');
    // The harness proves a transcript whose newest record is the agent mid-turn.
    harness.transcripts.set(id, { stamp: STAMP('/t/bodhi.jsonl', 10), records: [{ kind: 'work' }] });
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, working('w1'));
    await tick(h);
    const before = heard.length;

    // The turn ends: the pane shows only its idle prompt. One idle frame alone ends nothing: the transcript still says the agent is mid-turn.
    runner.screens.delete(handle);
    await tick(h);
    expect((await h.provided(FerretsPort).get(id))?.state).toBe('working');
    await tick(h);
    expect((await h.provided(FerretsPort).get(id))?.state).toBe('idle');
    expect(heard.slice(before)).toEqual([{ ferret: id, state: 'idle', previous: 'working', change: 'state' }]);

    // A new turn: the pane draws again.
    runner.screens.set(handle, working('w2'));
    await tick(h);
    expect((await h.provided(FerretsPort).get(id))?.state).toBe('working');
    expect(heard.at(-1)).toEqual({ ferret: id, state: 'working', previous: 'idle', change: 'state' });
    await h.stop();
  });

  test("BG-040 a document left starting by a crash is brought to its ferret's state when the watch arms, and its turns are watched", async () => {
    const { h, runner } = await host();
    const id = await start(h, 'gale');
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.settle();
    // The crash window: the registry wrote the ferret's state, the status lane never did.
    const folder = h.state('ferrets');
    const document = JSON.parse(folder.raw(FerretStateFile, id) ?? '{}') as Record<string, unknown>;
    expect(document.status).toBe('running');
    folder.plant(FerretStateFile, JSON.stringify({ ...document, status: 'starting' }), id);

    await h.runJob(TURN_WATCH_JOB);
    await h.settle();
    // The status lane runs off the job, as every edge's does: a few turns of the loop, bounded.
    for (
      let turn = 0;
      turn < 50 && JSON.parse(folder.raw(FerretStateFile, id) ?? '{}').status === 'starting';
      turn += 1
    )
      await Bun.sleep(0);
    expect(JSON.parse(folder.raw(FerretStateFile, id) ?? '{}').status).toBe('running');

    // And its turn is now recorded: the pane draws, so the ferret is seen working.
    runner.screens.set(handle, working('w1'));
    await tick(h);
    expect(JSON.parse(folder.raw(FerretStateFile, id) ?? '{}').turnState).toBe('working');
    await h.stop();
  });

  test('a stopped ferret is never looked at', async () => {
    const { h, runner } = await host();
    const id = await start(h, 'cyra');
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    // The stop itself looks once, before the pane goes, to keep its last screen (F-0326); the watch never does after.
    const atStop = [...runner.looked];
    expect(atStop.length).toBe(1);
    await h.runJob(TURN_WATCH_JOB);
    await tick(h);
    await tick(h);
    expect(runner.looked).toEqual(atStop);
    await h.stop();
  });

  test('FerretsApi.prompt serves the recorded dialog masked, and only to the ferret itself and its lead', async () => {
    const { h, runner } = await host();
    const id = await start(h, 'dara');
    const other = await start(h, 'emre');
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, {
      frame: 'p1',
      working: false,
      atPrompt: false,
      permission: true,
      prompt: `Trust the folder holding ${SECRET}?`,
    });
    await tick(h);

    const prompt = await h.provided(FerretsPort).prompt?.(id);
    expect(prompt?.turnState).toBe('needs-input');
    expect(prompt?.prompt).toBe(`Trust the folder holding ${'*'.repeat(SECRET.length)}?`);
    expect(JSON.stringify(prompt)).not.toContain(SECRET);
    expect(await h.provided(FerretsPort).prompt?.(id, id)).toEqual(prompt);
    await expect(h.provided(FerretsPort).prompt?.(id, other)).rejects.toMatchObject({ status: 403 });
    expect(await h.provided(FerretsPort).prompt?.('nobody-1' as FerretId)).toBeUndefined();
    await h.stop();
  });

  test('a launch hands the pane its own question file (FY_QUESTION_FILE) inside its session folder', async () => {
    const { h, vault } = await host();
    const id = await start(h, 'fenn');
    const env = vault.asked.at(-1) ?? {};
    expect(env[QUESTION_FILE_VARIABLE]).toEndWith(`/sessions/${id}/question-asked.json`);
    await h.stop();
  });
});

describe('the live readout and the transcript signal (U5, G161)', () => {
  /** A working ferret whose pane paints a status line naming a secret, and whose transcript spent tokens this turn. */
  async function working_ferret(name: string, status = `✻ Pondering ${SECRET}… (3s · esc to interrupt)`) {
    const world = await host();
    const { h, runner, harness } = world;
    const id = await start(h, name);
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, { ...working('w1'), status });
    await tick(h);
    const at = new Date(h.clock.nowMs()).toISOString() as HarnessTailRecord['at'];
    harness.transcripts.set(id, {
      stamp: STAMP(`/t/${name}.jsonl`, 10),
      records: [
        { kind: 'message', role: 'user', at },
        { kind: 'work', at },
        { kind: 'usage', at, call: 'm1', inputTokens: 100, outputTokens: 42 },
      ],
    });
    return { ...world, id, handle };
  }

  const liveFrames = (frames: readonly (string | Uint8Array)[]) =>
    frames
      .map(frame => JSON.parse(String(frame)) as { kind: string; live?: Record<string, unknown> })
      .filter(f => f.kind === 'live');

  test('J-0240 a ?live=1 stream samples the working turn every 500 ms: counts from the harness tail, the verb masked, no text', async () => {
    const { h, id, harness } = await working_ferret('gwen');
    const socket = await h.socket('/v1/events', { query: { sessionId: id, live: '1' } });
    expect(socket.response).toBeUndefined();

    await advance(h, 500);
    const [first] = liveFrames(socket.frames);
    expect(first?.live).toMatchObject({
      sessionId: id,
      outputTokens: 42,
      outputSource: 'transcript',
      verb: `Pondering ${'*'.repeat(SECRET.length)}…`,
    });
    // G161: the frame is exactly the live-activity fields; nothing of the pane or the transcript rides along.
    expect(Object.keys(first?.live ?? {}).sort()).toEqual(
      ['at', 'inputTokens', 'outputSource', 'outputTokens', 'sessionId', 'turnStartedAt', 'verb'].sort(),
    );
    expect(JSON.stringify(socket.frames)).not.toContain(SECRET);
    // A quiet transcript costs one stamp per sample and is read once (a changed stamp re-reads it).
    const reads = harness.tailed.length;
    await advance(h, 1_000);
    expect(harness.tailed.length).toBe(reads);
    socket.handler?.close({ code: 1000, reason: 'done' } as never);
    await h.stop();
  });

  test('G161 J-0240 a verb painted with bidi, zero-width and control characters leaves without them, and a vault value split by one is still masked', async () => {
    const split = `${SECRET.slice(0, 6)}\u200b${SECRET.slice(6)}`;
    const { h, id } = await working_ferret('mara', `✻ \u202ePondering\u0007 ${split}… (3s · esc to interrupt)`);
    const socket = await h.socket('/v1/events', { query: { sessionId: id, live: '1' } });
    await advance(h, 500);
    const [first] = liveFrames(socket.frames);
    expect(first?.live?.verb).toBe(`Pondering ${'*'.repeat(SECRET.length)}…`);
    expect(JSON.stringify(socket.frames)).not.toContain(SECRET.slice(0, 6));
    socket.handler?.close({ code: 1000, reason: 'done' } as never);
    await h.stop();
  });

  test('J-0260 a ferret that stops is forgotten: its cached tail is dropped, so the next reader reads the transcript afresh', async () => {
    const { h, id, harness } = await working_ferret('otto');
    await tick(h);
    await tick(h);
    const read = harness.tailed.length;
    expect(read).toBeGreaterThan(0); // the turn watch read it, and its stamp has not moved since

    await h.provided(FerretsPort).stop(id, 'now');
    // A live readout is a first reader of the tail: it is served from the cache while one is held, and reads afresh after.
    const socket = await h.socket('/v1/events', { query: { sessionId: id, live: '1' } });
    await advance(h, 500);
    expect(harness.tailed.length).toBeGreaterThan(read);
    socket.handler?.close({ code: 1000, reason: 'done' } as never);
    await h.stop();
  });

  test('R522 a write the harness stamps sends one transcript frame with no content; the same stamp sends none', async () => {
    const { h, id, harness } = await working_ferret('jude');
    const socket = await h.socket('/v1/events', { query: { sessionId: id, transcript: '1' } });
    const moved = () =>
      socket.frames.map(frame => JSON.parse(String(frame)) as { kind: string }).filter(f => f.kind === 'transcript');
    await advance(h, 1_000);
    expect(moved()).toEqual([]);

    const found = harness.transcripts.get(id);
    if (found === undefined) throw new Error('the ferret has a transcript');
    harness.transcripts.set(id, { ...found, stamp: STAMP('/t/jude.jsonl', 25) });
    await advance(h, 1_000);
    expect(moved()).toHaveLength(1);
    expect(moved()[0]).toMatchObject({ kind: 'transcript', transcript: { sessionId: id } });
    await advance(h, 3_000);
    expect(moved()).toHaveLength(1);
    await h.stop();
  });

  test('R524 a stream that did not ask for transcript=1 never carries a transcript frame', async () => {
    const { h, id, harness } = await working_ferret('kei');
    const plain = await h.socket('/v1/events', { query: { sessionId: id } });
    const found = harness.transcripts.get(id);
    if (found === undefined) throw new Error('the ferret has a transcript');
    harness.transcripts.set(id, { ...found, stamp: STAMP('/t/kei.jsonl', 99) });
    await advance(h, 2_000);
    expect(plain.frames.map(frame => (JSON.parse(String(frame)) as { kind: string }).kind)).not.toContain('transcript');
    await h.stop();
  });

  test('G161 a ferret follows its own live readout and transcript signal and its helpers’, never another ferret’s: no frame, no look, no stamp', async () => {
    // The caller changes per request: the owner starts the ferrets, then a ferret's own token follows them.
    let standing: CallStanding = ownerStanding();
    const { h, runner, harness } = await host(() => standing, [admitting()]);
    const a = await start(h, 'ada');
    const b = await start(h, 'bea');
    const started = await h.provided(FerretsPort, 'packs').start({ folder: '/work/cleo', parent: a, by: 'pack' });
    if (!started.ok) throw new Error('the helper starts');
    const helper = started.value;
    const handleOf = async (id: FerretId) => (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    for (const id of [a, b, helper]) {
      runner.screens.set(await handleOf(id), { ...working('w1'), status: '✻ Pondering… (3s · esc to interrupt)' });
      harness.transcripts.set(id, {
        stamp: STAMP(`/t/${id}.jsonl`, 10),
        records: [
          {
            kind: 'usage',
            at: new Date(h.clock.nowMs()).toISOString() as HarnessTailRecord['at'],
            inputTokens: 1,
            outputTokens: 2,
          },
        ],
      });
    }
    await tick(h);

    const watched = (id: FerretId, mode: 'live' | 'transcript') =>
      h.socket('/v1/events', { query: { sessionId: id, [mode]: '1' } });
    const framesOf = (socket: Awaited<ReturnType<typeof watched>>) => socket.frames.length;

    // Another ferret's token: refused at accept, nothing sampled for the target.
    standing = ferretStanding(a);
    const handleB = await handleOf(b);
    const looksOfB = () => runner.looked.filter(each => each === handleB).length;
    const stampsOfB = () => harness.stamped.filter(ferret => ferret === b).length;
    const [lookedBefore, stampedBefore] = [looksOfB(), stampsOfB()];
    for (const mode of ['live', 'transcript'] as const) {
      const refused = await watched(b, mode);
      expect(refused.response?.status).toBe(403);
      expect(refused.response?.json<{ code?: string }>().code).toBe('forbidden');
      expect(framesOf(refused)).toBe(0);
    }
    await advance(h, 2_000);
    // Only the turn watch's own pace (at most one look and one stamp per 2 s tick): a followed readout asks every 500 ms.
    const refusedLooks = looksOfB() - lookedBefore;
    const refusedStamps = stampsOfB() - stampedBefore;
    expect(refusedLooks).toBeLessThanOrEqual(1);
    expect(refusedStamps).toBeLessThanOrEqual(1);

    // Its own readout and its helper's: allowed, and frames arrive.
    for (const id of [a, helper]) {
      const own = await watched(id, 'live');
      expect(own.response).toBeUndefined();
      await advance(h, 500);
      expect(framesOf(own)).toBeGreaterThan(0);
      own.handler?.close({ code: 1000, reason: 'done' } as never);
    }

    // A person, owner or device, follows any ferret.
    for (const person of [ownerStanding(), deviceStanding('phone-1')]) {
      standing = person;
      const seen = await watched(b, 'live');
      expect(seen.response).toBeUndefined();
      await advance(h, 2_000);
      expect(framesOf(seen)).toBeGreaterThan(0);
      seen.handler?.close({ code: 1000, reason: 'done' } as never);
    }
    await h.stop();
  });
});

describe('the archive pass (U6)', () => {
  test('J-0185 the archive pass is a kernel job, and a tick runs a pass only when one is due (an hour after the last)', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    expect(h.jobIds()).toContain(ARCHIVE_PASS_JOB);
    const first = await startFerret(h, 'aniya');
    await finishFerret(h, first);
    await pass(h, 60_000);
    const second = await startFerret(h, 'bodhi');
    await finishFerret(h, second);

    // A day later the first has been finished for a day and the second for a minute less: only the first leaves.
    await pass(h, 24 * HOUR_MS - 30_000);
    await tickArchive(h);
    expect((await archived(h)).sessions.map(view => view.config.id)).toEqual([first]);
    // The second is old enough half an hour on, but the pass is not due for an hour: the tick does nothing.
    await pass(h, 30 * 60_000);
    await tickArchive(h);
    expect((await archived(h)).count).toBe(1);
    // Past the hour the next tick runs the pass and it leaves too.
    await pass(h, 31 * 60_000);
    await tickArchive(h);
    expect((await archived(h)).sessions.map(view => view.config.id).sort()).toEqual([first, second].sort());
    await h.stop();
  });
});

describe('auto-resume and the agenda hook (J-0002 J-0015)', () => {
  const runtimesAllowing = (seen: AutoResumeDecideInput[]) =>
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
              seen.push(input);
              return { allow: true };
            },
          },
        }),
      },
    );

  test('J-0002 auto-resume is a job the daemon arms once it serves: nothing is resumed before it runs, one run resumes the ferret a host restart took down', async () => {
    const runner = new FakeRunner();
    const asked: AutoResumeDecideInput[] = [];
    let h = await ferretsHost([], { harness: new FakeHarness(), runner, plugins: [runtimesAllowing(asked)] });
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-j2' },
      body: { folder: '/work/a', name: 'wren', runtime: 'claude-work' },
    });
    expect(started.status).toBe(201);
    await h.settle();
    runner.reboot();
    h = await h.restart();
    expect(h.jobIds()).toContain(AUTO_RESUME_JOB);
    expect(AUTO_RESUME_JOB).toBe('ferrets.auto-resume');
    expect(asked).toEqual([]);
    expect(h.state('ferrets').raw(AutoResumeSummaryFile)).toBeUndefined();

    await h.runJob(AUTO_RESUME_JOB);
    await h.settle();
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}')).toEqual({
      format: 1,
      at: h.clock.now(),
      resumed: 1,
      skipped: [],
    });
    await h.stop();
  });

  test('J-0015 every turn edge the watch records says ferret.changed to the plugins that take it (Agenda refreshes its projection on it), and a frame that moves nothing says nothing', async () => {
    const agenda: FerretChangedPayload[] = [];
    const { h, runner, harness } = await host(() => ownerStanding(), [listenerPlugin(agenda, 'agenda') as never]);
    const id = await start(h, 'bodhi');
    harness.transcripts.set(id, { stamp: STAMP('/t/bodhi.jsonl', 10), records: [{ kind: 'work' }] });
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, working('w1'));
    await tick(h);
    const afterStart = agenda.filter(change => change.change === 'state').map(change => change.state);
    expect(afterStart.at(-1)).toBe('working');

    const heardBefore = agenda.length;
    runner.screens.set(handle, working('w1 again'));
    await tick(h);
    expect(agenda.length).toBe(heardBefore);

    runner.screens.delete(handle);
    await tick(h);
    await tick(h);
    expect(agenda.slice(heardBefore)).toEqual([{ ferret: id, state: 'idle', previous: 'working', change: 'state' }]);
    await h.stop();
  });
});

describe('pack starts (J-0057 J-0084)', () => {
  test('J-0057 a pack starts a helper through the port with its parent: Packs is asked on start.decide, and two identical starts are two ferrets, never one replayed', async () => {
    const packs = fakePacks();
    const { h, runner } = await host(() => ownerStanding(), [packs.plugin as never]);
    const lead = await start(h, 'ada');
    const request = {
      folder: '/work/cleo',
      parent: lead,
      by: 'pack' as const,
      pack: 'pack-1' as PackId,
      prompt: 'tidy the notes',
    };
    const first = await h.provided(FerretsPort, 'packs').start(request);
    const second = await h.provided(FerretsPort, 'packs').start(request);
    if (!first.ok || !second.ok) throw new Error('both pack starts are admitted');
    expect(first.value).not.toBe(second.value);
    const helpers = packs.asked.filter(asked => asked.parent === lead);
    expect(helpers).toHaveLength(2);
    expect(helpers[0]).toMatchObject({ parent: lead, by: 'pack', role: 'helper', folder: '/work/cleo' });
    expect(await h.provided(FerretsPort).get(first.value)).toMatchObject({ parent: lead, role: 'helper' });
    expect(runner.starts).toBe(3);
    await h.stop();
  });

  test('J-0084 the pack clean-up starts under the next system callsign (pack-000001, then pack-000002), with no parent and no delegation', async () => {
    // The clean-up is Packs': the port is taken as it, so the `pack` prefix and a `by: 'pack'` start are its own.
    const { h } = await host(() => ownerStanding(), [admitting()]);
    const port = h.provided(FerretsPort, 'packs');
    const callsign = (await port.systemCallsign?.('pack')) ?? '';
    expect(callsign).toBe('pack-000001');
    const started = await port.start({ folder: '/work/cleanup', by: 'pack', name: callsign });
    if (!started.ok) throw new Error('the clean-up starts');
    expect(await port.get(started.value)).toMatchObject({ name: 'pack-000001', role: 'lead' });
    expect(await port.systemCallsign?.('pack')).toBe('pack-000002');
    expect(JSON.parse(h.state('ferrets').files.get('system-callsigns.json') ?? '{}')).toEqual({ format: 1, pack: 2 });
    await h.stop();
  });
});

describe('the handover reconcile loop (J-0069 J-0107 J-0245 J-0247)', () => {
  const FOLLOW_MS = 15_000;
  const BACKSTOP_MS = 15 * 60_000;
  const settleLoop = async () => {
    for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0);
  };
  const counting = (port: StatePort, calls: { list: number; read: number }): StatePort =>
    new Proxy(port, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'list' || property === 'read')
          return (...args: unknown[]) => {
            calls[property] += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  const world = async (open: readonly string[], needs: Partial<SessionHandoverNeeds> = {}) => {
    const folder = new MemoryStateFolder();
    const real = folder.port([HandoverFiles]);
    for (const source of open) await new FileHandoverReceiptStore(real).write(handoverReceiptFor(source, 'req-1'));
    const calls = { list: 0, read: 0 };
    const armed: { intervalMs: number; tick: () => void; cancelled: number }[] = [];
    const releases: Array<() => void | Promise<void>> = [];
    const built = sessionHandoverModule.build(
      sessionHandoverNeedsForTest({
        state: counting(real, calls),
        ...needs,
        every: (intervalMs, tick) => {
          const timer = { intervalMs, tick, cancelled: 0 };
          armed.push(timer);
          return () => {
            timer.cancelled += 1;
          };
        },
      }),
      undefined,
      { onRelease: (_label, release) => void releases.push(release) },
    );
    return { folder, calls, armed, releases, built };
  };

  test('J-0069 the daemon declares ferrets.handover-reconcile: running it arms the loop on the kernel clock, and stopping the daemon cancels the timer', async () => {
    const { h } = await host();
    expect(h.jobIds()).toContain('ferrets.handover-reconcile');
    const before = h.clock.pending();
    await h.runJob('ferrets.handover-reconcile');
    await settleLoop();
    expect(h.clock.pending()).toBe(before + 1);
    await h.stop();
    expect(h.clock.pending()).toBe(before);
  });

  test('J-0107 J-0247 while a handover is open the loop ticks every 15 s and each tick advances every open receipt; the tick is dropped once none is open', async () => {
    // The source session cannot be read at boot (the directory rejects), so the boot pass advances nothing: both
    // receipts stay "requested". The directory then answers "this session is gone", and ONLY the follow tick can
    // move the receipts: each is settled `failed` / `source_lost`.
    const directory: { answer: 'unreadable' | 'gone' } = { answer: 'unreadable' };
    const sessions = {
      get: async () => {
        if (directory.answer === 'unreadable') throw new Error('the session directory is closed');
        return undefined;
      },
    } as unknown as SessionDirectorySubsystem;
    const { folder, calls, armed, built } = await world(['source-1', 'source-2'], { sessions });
    const receipts = new FileHandoverReceiptStore(folder.port([HandoverFiles]));
    built.jobs.arm();
    await settleLoop();
    expect(armed.map(timer => timer.intervalMs).sort((a, b) => a - b)).toEqual([FOLLOW_MS, BACKSTOP_MS]);
    const follow = armed.find(timer => timer.intervalMs === FOLLOW_MS);
    if (follow === undefined) throw new Error('the follow tick is armed');
    const bootLists = calls.list;
    expect((await receipts.read('source-1'))?.phase).toBe('requested');
    expect((await receipts.read('source-2'))?.phase).toBe('requested');

    directory.answer = 'gone';
    follow.tick();
    await settleLoop();
    expect(calls.list).toBe(bootLists);
    for (const source of ['source-1', 'source-2']) {
      const receipt = await receipts.read(source);
      expect(receipt).toMatchObject({ phase: 'failed', refusal: { failure: 'source_lost' } });
      expect(receipt?.phaseHistory.at(-1)?.phase).toBe('failed');
    }
    expect(follow.cancelled).toBe(1);
  });

  test('J-0245 a slow 15 min backstop forgets what is remembered and reads every receipt again, for a document that changed behind the daemon', async () => {
    const { folder, calls, armed, built } = await world([]);
    built.jobs.arm();
    await settleLoop();
    expect(armed.map(timer => timer.intervalMs)).toEqual([BACKSTOP_MS]);
    const listsAfterBoot = calls.list;

    await new FileHandoverReceiptStore(folder.port([HandoverFiles])).write(handoverReceiptFor('source-2', 'req-2'));
    armed[0]?.tick();
    await settleLoop();
    expect(calls.list).toBe(listsAfterBoot + 1);
    expect(armed.map(timer => timer.intervalMs).sort((a, b) => a - b)).toEqual([FOLLOW_MS, BACKSTOP_MS]);
  });
});

describe('the event stream keeps proving it is alive (J-0239)', () => {
  test('J-0239 GET /v1/events is a declared socket, and a quiet stream says idle again every 30 s; a real event re-arms the window instead', async () => {
    expect(manifest.actions?.sockets?.map(socket => socket.key)).toContain('GET /v1/events');
    const port = state.createStatePort({
      home: '/home/fy',
      pluginId: 'ferrets',
      files: [FerretHistoryFiles],
      fs: state.createMemoryHostFs(),
    });
    const event = createSessionEvent('wren' as SessionId, 0, '2026-11-08T10:00:00.000Z', 'session.turn', { n: 1 });
    await port.append(FerretHistoryFiles, encodeSessionEvent(event), 'wren');
    const source = new HistoryEventSource(port, () => ['wren']);
    const windows: { delay: number; fire: () => void; cancelled: boolean }[] = [];
    const accept = fleetEventsAccept(
      source,
      {
        after: (delay, fire) => {
          const window = { delay, fire, cancelled: false };
          windows.push(window);
          return {
            cancel: () => {
              window.cancelled = true;
            },
          };
        },
      },
      id => id === 'wren',
    );
    const attach = await accept({
      request: {
        query: queryFrom([
          ['sessionId', 'wren'],
          ['after', '0'],
        ]),
      },
      params: new Map(),
    } as never);
    const frames: { kind: string }[] = [];
    const downstream: SocketDownstream = {
      send: frame => {
        frames.push(JSON.parse(String(frame)) as { kind: string });
        return 1;
      },
      close: () => undefined,
      bufferedBytes: () => 0,
    };
    const handler = await attach(downstream);
    await handler.open();
    expect(frames.map(frame => frame.kind)).toEqual(['event', 'idle']);
    expect(windows.map(window => window.delay)).toEqual([30_000]);

    windows[0]?.fire();
    expect(frames.map(frame => frame.kind)).toEqual(['event', 'idle', 'idle']);
    expect(windows.map(window => window.delay)).toEqual([30_000, 30_000]);

    source.publish({
      sequence: 2,
      sessionId: 'wren',
      time: '2026-11-08T10:01:00.000Z',
      type: 'session.turn',
      data: { n: 2 },
    });
    expect(frames.map(frame => frame.kind)).toEqual(['event', 'idle', 'idle', 'event']);
    expect(windows[1]?.cancelled).toBe(true);
    expect(windows.map(window => window.delay)).toEqual([30_000, 30_000, 30_000]);
    handler.close();
    expect(windows[2]?.cancelled).toBe(true);
  });
});

describe('the cached document read (J-0259)', () => {
  test('J-0259 no watcher guards a cached copy any more: a session document changed behind the daemon is read as it now is', async () => {
    const { storage, folder } = await memoryStorage();
    const id = parseSessionId('mw7bp88g-50e00159');
    await storage.writeConfig(id, sessionConfig(id, { name: 'zelda' }));
    expect(((await storage.readConfig(id)) as { name: string }).name).toBe('zelda');
    folder.files.set(`${id}/config.json`, JSON.stringify({ format: 1, ...sessionConfig(id, { name: 'wren' }) }));
    expect(((await storage.readConfig(id)) as { name: string }).name).toBe('wren');
    folder.files.set(`${id}/state.json`, JSON.stringify({ format: 1, ...sessionState(id, { turn: 7 }) }));
    expect(((await storage.readState(id)) as { turn: number }).turn).toBe(7);
    await storage.close();
  });
});

describe('the session index is rebuilt at boot (BG-049, J-0159)', () => {
  const sessionRows = (folder: MemoryStateFolder): readonly unknown[] =>
    folder.databases.get(FerretIndexFile.path)?.query('SELECT * FROM sessions ORDER BY id').all() ?? [];
  const eventRows = (folder: MemoryStateFolder): readonly unknown[] =>
    folder.databases.get(FerretIndexFile.path)?.query('SELECT * FROM events ORDER BY session_id, sequence').all() ?? [];
  const loseCache = (folder: MemoryStateFolder): void => {
    folder.databases.get(FerretIndexFile.path)?.close();
    folder.databases.delete(FerretIndexFile.path);
  };

  test('J-0159 a session written before a restart is listed after it: the boot job ferrets.index-rebuild rebuilds a lost cache to the index the daemon had', async () => {
    let h = await ferretsHost([]);
    const folder = h.state('ferrets');
    const written = await generatedFleet(60, folder);
    const sessionsBefore = sessionRows(folder);
    const eventsBefore = eventRows(folder);
    expect(sessionsBefore).toHaveLength(60);
    expect(eventsBefore).toHaveLength(120);
    await written.storage.close();
    await h.stop();
    loseCache(folder);

    h = await h.restart();
    expect(INDEX_REBUILD_JOB).toBe('ferrets.index-rebuild');
    expect(h.jobIds()).toContain(INDEX_REBUILD_JOB);
    // Nothing rebuilds it before the job runs: the state the owner met.
    expect(sessionRows(folder)).toEqual([]);

    // The host's clock is driven: each slice's yield is a zero-length sleep on it, so the job is run while it is advanced.
    let finished = false;
    const running = h.runJob(INDEX_REBUILD_JOB).finally(() => {
      finished = true;
    });
    for (let turns = 0; !finished && turns < 1_000; turns += 1) {
      await h.clock.advance(0);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await running;
    await h.settle();

    expect(sessionRows(folder)).toEqual(sessionsBefore);
    expect(eventRows(folder)).toEqual(eventsBefore);
    await h.stop();
  });

  test('J-0159 there is no write-behind to stall: the rebuild hands the loop back after every slice, and a write between two slices is not held until it ends', async () => {
    const lost = await restartWithCacheLost(await generatedFleet(60));
    let yields = 0;
    let written: Promise<unknown> | undefined;

    const result = await lost.storage.rebuildIndexYielding({
      sliceSize: 25,
      yieldToLoop: async () => {
        yields += 1;
        // A caller writes a session the rebuild has not reached yet; the write must land before the next slice.
        if (yields === 1) {
          written = lost.storage.append(sessionIdAt(59), 'note', { n: 3 });
          await Promise.race([written, new Promise(resolve => setTimeout(resolve, 1_000))]);
          expect(lost.storage.listSessions().find(session => session.id === sessionIdAt(59))?.lastSequence).toBe(3);
        }
      },
    });

    // 59: the session written between the slices was indexed by its own write, so the rebuild left its row alone.
    expect(result).toMatchObject({ missing: 60, rebuilt: 59, complete: true });
    expect(yields).toBeGreaterThanOrEqual(Math.ceil(60 / 25));
    await written;
    expect(lost.storage.listSessions()).toHaveLength(60);
    expect(lost.storage.listSessions().find(session => session.id === sessionIdAt(59))?.lastSequence).toBe(3);
    await lost.storage.close();
  });
});
