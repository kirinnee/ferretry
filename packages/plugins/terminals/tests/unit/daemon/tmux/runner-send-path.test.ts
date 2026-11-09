import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import type { Redaction, RedactionScope } from '@ferretry/kernel/contract';
import { ComposerActs } from '../../../../daemon/adapters/tmux/composer-acts.ts';
import type { TmuxController } from '../../../../daemon/lib/tmux/index.ts';
import { subject } from './runner-world.ts';

const failureOf = async (promise: Promise<unknown>) =>
  runnerDeliveryFailure(
    await promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
const TRUST = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
const TRUST_WITH_SECRET = 'Do you trust the files in this folder hunter2?\n❯ 1. Yes, proceed\n  2. No, exit';
const keys = (world: ReturnType<typeof subject>) =>
  world.server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1));

/** A Vault that has learned one secret: every line it reads is returned with that value starred. */
const redacting = (secret: string): Redaction => ({
  read: async fn =>
    await fn({
      lines: (lines: readonly string[]) => lines.map(line => line.split(secret).join('*'.repeat(secret.length))),
    } as unknown as RedactionScope),
});

describe('send path: the runner reads the pane (observe, heldAt)', () => {
  it('observe says an idle prompt with nothing typed, writes nothing and is not an act', async () => {
    const world = subject();
    const seen = await world.runner.observe(world.handle);
    expect(seen).toMatchObject({ alive: true, dead: false, promptReady: true, activeWork: false });
    expect(seen?.draft).toBeUndefined();
    expect(seen?.blockingPrompt).toBeUndefined();
    expect(keys(world)).toEqual([]);
    expect(world.acts).toEqual([]);
  });

  it('observe carries the person’s own unsent draft, so a send can refuse around it', async () => {
    const world = subject();
    world.server.composer = 'half written';
    expect((await world.runner.observe(world.handle))?.draft).toBe('half written');
  });

  it('observe says a pane at work and a pane behind a dialog', async () => {
    const working = subject();
    working.server.working = true;
    expect((await working.runner.observe(working.handle))?.activeWork).toBe(true);
    const parked = subject();
    parked.server.modal = TRUST;
    expect((await parked.runner.observe(parked.handle))?.blockingPrompt).toBeDefined();
  });

  it('observe masks the words of a blocking prompt inside one Redaction.read, and says a fixed sentence with none bound', async () => {
    const masked = subject({ redaction: redacting('hunter2') });
    masked.server.modal = TRUST_WITH_SECRET;
    const prompt = (await masked.runner.observe(masked.handle))?.blockingPrompt ?? '';
    expect(prompt).not.toContain('hunter2');
    const bare = subject();
    bare.server.modal = TRUST_WITH_SECRET;
    expect((await bare.runner.observe(bare.handle))?.blockingPrompt).toBe('a prompt on its screen');
  });

  it('observe is total: a pane that is gone, replaced or unreadable reads undefined', async () => {
    const gone = subject();
    gone.server.alive = false;
    expect(await gone.runner.observe(gone.handle)).toBeUndefined();
    const replaced = subject();
    replaced.replace({ session: 'fy-webterm-person' });
    expect(await replaced.runner.observe(replaced.handle)).toBeUndefined();
    const broken = subject();
    broken.throwOn('capture-pane');
    expect(await broken.runner.observe(broken.handle)).toBeUndefined();
  });

  it('heldAt says where a message is held, nowhere else, and writes nothing', async () => {
    const world = subject();
    expect(await world.runner.heldAt(world.handle, 'one send')).toBeUndefined();
    world.server.composer = 'one send';
    expect(await world.runner.heldAt(world.handle, 'one send')).toBe('composer');
    world.server.composer = '';
    world.server.transcript = 'one send';
    // The words anywhere else on screen (the conversation it was already sent into) are not "held".
    expect(await world.runner.heldAt(world.handle, 'one send')).toBeUndefined();
    expect(keys(world)).toEqual([]);
    expect(world.acts).toEqual([]);
  });

  it('heldAt REJECTS when the pane cannot be read: an unread pane never licenses a retype', async () => {
    const world = subject();
    world.throwOn('capture-pane');
    await expect(world.runner.heldAt(world.handle, 'one send')).rejects.toThrow();
    const gone = subject();
    gone.server.alive = false;
    await expect(gone.runner.heldAt(gone.handle, 'one send')).rejects.toMatchObject({
      deliveryFailure: expect.anything(),
    });
  });

  it('a read types nothing even through the read binding: a write is refused before tmux', async () => {
    const world = subject();
    world.server.composer = 'one send';
    await world.runner.heldAt(world.handle, 'one send');
    await world.runner.observe(world.handle);
    expect(world.server.calls.some(call => call[0] === 'send-keys' || call[0] === 'paste-buffer')).toBe(false);
    expect(world.guards).toEqual([]);
  });
});

describe('send path: the composer acts (clearComposer, submitComposer)', () => {
  it('clearComposer erases its own message one C-u at a time, acted on the exact pane', async () => {
    const world = subject();
    world.server.composer = 'one send';
    expect(await world.runner.clearComposer(world.handle, 'one send')).toBe('cleared');
    expect(keys(world)).toEqual(['C-u']);
    expect(world.server.composer).toBe('');
    expect(world.acts[0]).toMatchObject({ op: 'keys', target: { key: world.handle }, outcome: 'ran' });
  });

  it('clearComposer never erases a person’s own draft (foreign) and presses nothing', async () => {
    const world = subject();
    world.server.composer = 'my own words';
    expect(await world.runner.clearComposer(world.handle, 'one send')).toBe('foreign');
    expect(keys(world)).toEqual([]);
    expect(world.server.composer).toBe('my own words');
  });

  it('clearComposer on an empty composer is absent, and never sends BSpace', async () => {
    const world = subject();
    expect(await world.runner.clearComposer(world.handle, 'one send')).toBe('absent');
    expect(keys(world)).toEqual([]);
  });

  it('submitComposer presses ONE Enter for exactly its message and says it left', async () => {
    const world = subject();
    world.server.composer = 'one send';
    expect(await world.runner.submitComposer(world.handle, 'one send')).toBe('submitted');
    expect(keys(world)).toEqual(['Enter']);
    expect(world.server.submitted).toEqual(['one send']);
    expect(world.acts[0]).toMatchObject({ op: 'keys', outcome: 'ran' });
  });

  it('submitComposer never presses Enter for a composer that holds anything else, or at a pane at work', async () => {
    const other = subject();
    other.server.composer = 'one send and more';
    expect(await other.runner.submitComposer(other.handle, 'one send')).toBe('absent');
    expect(keys(other)).toEqual([]);
    const working = subject();
    working.server.composer = 'one send';
    working.server.working = true;
    expect(await working.runner.submitComposer(working.handle, 'one send')).toBe('absent');
    expect(keys(working)).toEqual([]);
    const behind = subject();
    behind.server.composer = 'one send';
    behind.server.modal = TRUST;
    expect(await behind.runner.submitComposer(behind.handle, 'one send')).toBe('absent');
    expect(keys(behind)).toEqual([]);
  });

  it('submitComposer strict refuses a clipped drawing and accepts the whole text', async () => {
    const world = subject();
    world.server.composer = 'one send';
    expect(await world.runner.submitComposer(world.handle, 'one send and the rest', true)).toBe('absent');
    expect(await world.runner.submitComposer(world.handle, 'one send', true)).toBe('submitted');
  });

  for (const act of ['clearComposer', 'submitComposer'] as const) {
    it(`${act} types nothing when a Vault hold refuses the write, and says the closed code`, async () => {
      const world = subject();
      world.server.composer = 'one send';
      world.hold();
      expect(await failureOf(world.runner[act](world.handle, 'one send'))).toEqual({
        kind: 'held',
        code: 'input_pending',
      });
      expect(keys(world)).toEqual([]);
      expect(world.server.composer).toBe('one send');
    });

    it(`${act} with no act runner bound fails closed before any key`, async () => {
      const world = subject({ unguarded: true });
      expect(await failureOf(world.runner[act](world.handle, 'one send'))).toEqual({
        kind: 'held',
        code: 'holds_unavailable',
      });
      expect(keys(world)).toEqual([]);
    });

    it(`${act} at a pane that changed under it presses nothing and says not_ready`, async () => {
      const world = subject();
      world.server.composer = 'one send';
      world.beforeGuard(() => world.replace({ pid: 9999 }));
      expect(await failureOf(world.runner[act](world.handle, 'one send'))).toEqual({
        kind: 'not_ready',
        why: 'exited',
      });
      expect(keys(world)).toEqual([]);
    });
  }
});

describe('send path: stopActiveTurn presses the harness stop under shouldPressStopKey, waits, then reads', () => {
  it('a working pane gets exactly one Escape (never C-c), then its read', async () => {
    const world = subject();
    world.server.working = true;
    const seen = await world.runner.stopActiveTurn(world.handle, { key: 'Escape', whenIdle: false });
    expect(keys(world)).toEqual(['Escape']);
    expect(world.server.calls.some(call => call.includes('C-c'))).toBe(false);
    expect(seen).toMatchObject({ alive: true });
  });

  it('an idle pane whose key is not harmless there is never pressed, and is still read', async () => {
    const world = subject();
    const seen = await world.runner.stopActiveTurn(world.handle, { key: 'Escape', whenIdle: false });
    expect(keys(world)).toEqual([]);
    expect(seen).toMatchObject({ promptReady: true });
  });

  it('m1 a frame with an active-work line AND a permission prompt is not pressed by stopActiveTurn: Escape would answer it', async () => {
    const world = subject();
    world.server.working = true;
    world.server.modal = TRUST;
    const seen = await world.runner.stopActiveTurn(world.handle, { key: 'Escape', whenIdle: false });
    expect(keys(world)).toEqual([]);
    expect(seen?.blockingPrompt).toBeDefined();
  });

  it('m1 a frame with an active-work line under Codex’s startup wait is not pressed by stopActiveTurn either', async () => {
    const world = subject();
    world.server.working = true;
    world.server.startupWaitUntilMs = Number.MAX_SAFE_INTEGER;
    await world.runner.stopActiveTurn(world.handle, { key: 'Escape', whenIdle: false });
    expect(keys(world)).toEqual([]);
  });

  it('m1 the person’s own interrupt (stopTurn) keeps today’s rule: the same frame is pressed', async () => {
    const world = subject();
    world.server.working = true;
    world.server.modal = TRUST;
    expect(await world.runner.stopTurn(world.handle, { key: 'Escape', whenIdle: false })).toMatchObject({
      pressed: true,
    });
    expect(keys(world)).toEqual(['Escape']);
  });

  it('a hold refuses the stop and presses nothing', async () => {
    const world = subject();
    world.server.working = true;
    world.hold();
    expect(await failureOf(world.runner.stopActiveTurn(world.handle, { key: 'Escape', whenIdle: false }))).toEqual({
      kind: 'held',
      code: 'input_pending',
    });
    expect(keys(world)).toEqual([]);
  });
});

describe('send path: the composer acts keep their bounds', () => {
  it('submitComposer says holding when the composer still shows the message after every poll', async () => {
    const world = subject();
    world.server.composer = 'one send';
    world.server.swallowEnters = 99;
    expect(await world.runner.submitComposer(world.handle, 'one send')).toBe('holding');
    expect(keys(world)).toEqual(['Enter']);
  });

  it('clearComposer stops, never wipes, when erasing stops making progress or the composer cannot be read', async () => {
    const multi = subject();
    multi.server.composer = 'line one\nline two';
    const outcome = await multi.runner.clearComposer(multi.handle, 'line one\nline two');
    expect(['cleared', 'stuck']).toContain(outcome);
    expect(keys(multi).every(key => key === 'C-u')).toBe(true);
    const covered = subject();
    covered.server.composer = 'one send';
    covered.server.modal = TRUST;
    covered.server.modalReplacesComposer = true;
    expect(await covered.runner.clearComposer(covered.handle, 'one send')).toBe('stuck');
    expect(keys(covered)).toEqual([]);
  });

  it('heldAt REJECTS for a queue that runs past what the pane shows: "not held" would license a retype', async () => {
    const frame = readFileSync(
      join(import.meta.dir, '../../../fixtures/composer/claude-2.1.281-busy-queued-overflow.txt'),
      'utf8',
    );
    const tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: false,
        history: '',
        visible: frame,
        cursorX: 2,
        cursorY: 17,
      }),
      rows: async () => undefined,
    } as unknown as TmuxController;
    const acts = new ComposerActs(tmux, 'fy-f-hadi', async () => undefined);
    await expect(acts.heldAt('a message that was never typed here at all')).rejects.toThrow(/runs past/);
  });
});
