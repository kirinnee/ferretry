import { describe, expect, it } from 'bun:test';
import { runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import { turnLookOf } from '../../../../daemon/lib/tmux/turn-look.ts';
import { subject } from './runner-world.ts';

/**
 * B188 — a peer's message handed over while an IDLE ferret compacts.
 *
 * The real runner (observe, deliver, the composer acts and the pane parsers) over the fake tmux server and its virtual
 * clock: no tmux process, no real sleep. An idle compaction starts from a finished turn, so for its first seconds the
 * pane shows only `<tick> Compacting conversation…`, on a `·` tick that the general spinner phrase does not take, with
 * no clock or token counter yet. The pane read it as an idle prompt, the transcript said the turn had ended, and a
 * message was typed straight into the compacting composer.
 */

const MESSAGE = '[message · from :ireland · peer]\nPlease keep the queue ordering as v4 and tell me when it is in.';
const WINDOW_MS = 60_000;
const LOOK_EVERY_MS = 2_000;
/** What Claude draws while it compacts, alternating tick by tick: the `·` frame has no parenthetical yet. */
const COMPACTING = [
  '· Compacting conversation…',
  '✶ Compacting conversation… (3s)',
  '* Compacting conversation…',
  '✢ Compacting conversation... (esc to interrupt)',
];
const IDLE = '✻ Compacted while idle, before the prompt cache expired · done 10:56 AM';

const failureOf = async (promise: Promise<unknown>) =>
  runnerDeliveryFailure(
    await promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
const written = (world: ReturnType<typeof subject>): boolean =>
  world.server.calls.some(call => ['send-keys', 'paste-buffer', 'load-buffer'].includes(call[0] ?? ''));

/** What the turn watcher reads off the frame the pane shows now (the same parsers `Runner.look` runs). */
async function lookAt(world: ReturnType<typeof subject>) {
  const seen = await world.runner.observe(world.handle);
  const frame = (await world.server.execute(['capture-pane', '-p', '-t', world.handle])).stdout;
  return {
    seen,
    look: turnLookOf(
      { dead: false, alive: true, promptReady: seen?.promptReady ?? false, history: '', visible: frame },
      text => text,
    ),
  };
}

describe('B188 a draft of our own is left in the box, then an idle compaction', () => {
  it('B188 nothing is typed or submitted while the compaction shows, and the first look after the summary reads an idle prompt through the draft', async () => {
    const world = subject();
    world.server.transcript = 'Done. The queue now delivers in order.\n';
    // The daemon's own text, drawn late: it sits in the composer, unsent.
    world.server.composer = 'Read the file /x/turn-063.md now, then follow it';
    const started = world.server.nowMs;
    let looks = 0;

    while (world.server.nowMs - started < WINDOW_MS) {
      world.server.transcript = `Done. The queue now delivers in order.\n\n${COMPACTING[looks % COMPACTING.length]}\n`;
      looks += 1;
      const { seen, look } = await lookAt(world);

      // Work the transcript cannot overrule, with the draft still in the box: the turn reads working inside the window.
      expect(look).toMatchObject({ working: true, atPrompt: false });
      expect(seen).toMatchObject({ activeWork: true, compacting: true, draft: world.server.composer });
      // A hand-over types nothing: the box holds the daemon's own text, and the pane is at work besides.
      expect(await failureOf(world.runner.deliver(world.handle, { text: MESSAGE }))).toEqual({
        kind: 'composer_occupied',
        draft: 'Read the file /x/turn-063.md now, then follow it',
      });
      world.server.advance(LOOK_EVERY_MS);
    }

    // Nothing was typed or submitted, and the draft is exactly as it was.
    expect(written(world)).toBe(false);
    expect(world.server.submitted).toEqual([]);
    expect(world.server.composer).toBe('Read the file /x/turn-063.md now, then follow it');

    // The summary is written and the pane shows its idle frame, the draft still in the box. A send would not be accepted
    // (the cursor is on the draft), but the turn look reads an idle prompt on the FIRST look.
    world.server.transcript = `Done. The queue now delivers in order.\n\n${IDLE}\n`;
    const idle = await lookAt(world);
    expect(idle.seen).toMatchObject({ activeWork: false, compacting: false, promptReady: false });
    expect(idle.look).toMatchObject({ working: false, atPrompt: true });
  });
});

describe('B188 a send handed over during an idle compaction', () => {
  it('B188 types no key into the compacting composer, never reads idle inside the window, and delivers once after it', async () => {
    const world = subject();
    world.server.transcript = 'Done. The queue now delivers in order.\n';
    const started = world.server.nowMs;
    let handedOver = false;
    let looks = 0;

    // The compaction window: the ferret is at an idle prompt (transcript ended, record ready) and the pane shows only
    // the compaction line, alternating its tick every look.
    while (world.server.nowMs - started < WINDOW_MS) {
      world.server.transcript = `Done. The queue now delivers in order.\n\n${COMPACTING[looks % COMPACTING.length]}\n`;
      looks += 1;
      const { seen, look } = await lookAt(world);

      // The turn reading: work the transcript cannot overrule, and no prompt to settle `your-turn` on.
      expect(look).toMatchObject({ working: true, atPrompt: false });
      expect(look.spinnerOnly).toBeUndefined();
      // The send path's reading: work on screen, no composer to type into.
      expect(seen).toMatchObject({ alive: true, activeWork: true, compacting: true, promptReady: false });

      // At +4 s the queue hands the peer's message over.
      if (!handedOver && world.server.nowMs - started >= 4_000) {
        handedOver = true;
        expect(await failureOf(world.runner.deliver(world.handle, { text: MESSAGE }))).toEqual({
          kind: 'not_ready',
          why: 'busy',
        });
      } else world.server.advance(LOOK_EVERY_MS);
    }

    // Nothing was typed, nothing submitted, the composer is empty.
    expect(handedOver).toBe(true);
    expect(written(world)).toBe(false);
    expect(world.server.submitted).toEqual([]);
    expect(world.server.composer).toBe('');

    // The compaction ends: the summary is written and the pane shows its idle frame. The turn reads idle.
    world.server.transcript = `Done. The queue now delivers in order.\n\n${IDLE}\n`;
    const idle = await lookAt(world);
    expect(idle.look).toMatchObject({ working: false, atPrompt: true });
    expect(idle.seen).toMatchObject({ activeWork: false, compacting: false, promptReady: true });

    // The queue's next look hands the same message over: it is typed once and submitted once.
    await world.runner.deliver(world.handle, { text: MESSAGE });
    expect(world.server.submitted).toEqual([MESSAGE]);
  });
});
