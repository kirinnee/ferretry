import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import {
  type FerretId,
  FerretsPort,
  Harnesses,
  type RunnerHandle,
  Runners,
} from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * A STORED QUESTION READS AS "WAITING ON A PERSON", through the daemon: the REAL Ferrets and the REAL Conversation
 * halves, as the generated registry builds them. Conversation stores what a Claude ferret asks as `question.json` (read
 * off the pane, so the transcript, which Claude writes only once the form is answered, still says mid-turn), and Ferrets'
 * turn watch asks Conversation, through the `turn.question-open` provider, whether one is open: while it is the ferret is
 * `idle` and its recorded turn is `needs-input`; answered, it goes back to `working`.
 *
 * CI only (integration tier). Fixture values only.
 */

/** Ferrets' job that arms the turn watch (its contract does not export the id; the host lists it). */
const TURN_WATCH_JOB = 'ferrets.turn-watch';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

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

const TRANSCRIPT = '/transcripts/a.jsonl';
const STORED = JSON.stringify({
  format: 1,
  toolUseId: 'pane:0123456789abcdef',
  text: 'Deploy?',
  options: [{ label: 'Yes' }, { label: 'No' }],
  multiple: false,
  askedAt: '2026-11-07T08:59:00.000Z',
  transcript: TRANSCRIPT,
});

/** A pane that is drawing: the harness's own working line. */
const working = (frame: string) => ({ frame, working: true, atPrompt: false, permission: false });

async function boot() {
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  const h = await testHost({
    plugins: [real('ferrets'), real('mailbox'), real('conversation'), harnessPlugin(harness), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    everyDirectory: true,
  });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Ask me.' },
  });
  expect(started.status).toBeLessThan(300);
  await h.settle();
  const id = started.json<{ id: FerretId }>().id;
  // The transcript's newest record is the agent mid-turn: the harness writes the question's call only once it is answered.
  harness.transcripts.set(id as never, {
    stamp: { file: TRANSCRIPT, size: 1, mtimeMs: 1 },
    records: [{ kind: 'work' }],
  });
  const handle = (await h.provided(FerretsPort).handle(id)) as RunnerHandle;
  return { h, runner, id, handle };
}

/** Moves the driven clock one 2 s tick and lets the turn watch's look run to its end. */
async function tick(h: TestHost): Promise<void> {
  await h.clock.advance(2_000);
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(0);
  }
  await h.settle();
}

const stateOf = async (h: TestHost, id: FerretId) => (await h.provided(FerretsPort).get(id))?.state;

describe('a question Conversation stores, seen by the turn watch, through the real halves', () => {
  test('the ferret is idle (needs-input) while the stored question is open, and working again once it is gone', async () => {
    const { h, runner, id, handle } = await boot();
    await h.runJob(TURN_WATCH_JOB);
    runner.screens.set(handle, working('w1'));
    await tick(h);
    expect(await stateOf(h, id)).toBe('working');

    h.state('conversation').plant(QUESTION_STATE, STORED, id);
    runner.screens.set(handle, working('w2'));
    await tick(h);
    expect(await stateOf(h, id)).toBe('idle');
    expect((await h.provided(FerretsPort).prompt?.(id))?.turnState).toBe('needs-input');

    // Answered: Conversation clears `question.json`, and the turn carries on.
    h.state('conversation').plant(QUESTION_STATE, '', id);
    runner.screens.set(handle, working('w3'));
    await tick(h);
    expect(await stateOf(h, id)).toBe('working');
    await h.stop();
  });
});
