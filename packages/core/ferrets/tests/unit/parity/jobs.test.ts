/**
 * Parity rows J-0001, J-0260 (docs/design/rebuild-parity.tsv): the turn watch, mounted in Ferrets (U4); J-0240: the live
 * readout and the transcript signal on `GET /v1/events`, mounted in Ferrets (U5).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { ChildEnvironment, SecretName } from '@ferretry/core-vault/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import type { Result } from '@ferretry/std';
import {
  FerretChanged,
  type FerretChangedPayload,
  FerretsPort,
  Harnesses,
  type RunnerHandle,
  type HarnessTailRecord,
  type HarnessTranscriptStamp,
  type RunnerLook,
  Runners,
} from '../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import ferrets, { TURN_WATCH_JOB } from '../../../daemon/index.ts';
import { QUESTION_FILE_VARIABLE } from '../../../daemon/lib/ferrets/service.ts';

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
const listenerPlugin = (heard: FerretChangedPayload[]) =>
  implementDaemon(
    definePlugin({
      id: 'conversation',
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

async function host() {
  const runner = new FakeRunner();
  const heard: FerretChangedPayload[] = [];
  const vault = new RecordingVault();
  const harness = new FakeHarness();
  const h = await testHost({
    plugins: [ferrets, harnessPlugin(harness), runnerPlugin(runner), listenerPlugin(heard)],
    gate: new StandInAdmission(() => ownerStanding()),
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

  test('a stopped ferret is never looked at', async () => {
    const { h, runner } = await host();
    const id = await start(h, 'cyra');
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    await h.runJob(TURN_WATCH_JOB);
    await tick(h);
    await tick(h);
    expect(runner.looked).toEqual([]);
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
  async function working_ferret(name: string) {
    const world = await host();
    const { h, runner, harness } = world;
    const id = await start(h, name);
    const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, { ...working('w1'), status: `✻ Pondering ${SECRET}… (3s · esc to interrupt)` });
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
});
