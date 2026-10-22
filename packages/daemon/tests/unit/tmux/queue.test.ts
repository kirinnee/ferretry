import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { type DeliveryFrame, needsQueueKey, queuedWhere } from '../../../src/lib/tmux/index.ts';

/**
 * What a frame proves about a message put into a BUSY pane's own queue.
 *
 * `delivery.ts` proves a payload LEFT the composer; here leaving it is only half the answer — the
 * message has to turn up in the harness's own queue before anything may call it queued.
 */

const TEXT = 'read the queued brief';
const WORKING = '✻ Lollygagging… (34s · ⚒ 2.1k tokens)';
const FIXTURES = join(import.meta.dir, '../../fixtures/composer');

/** A frame with no cursor: the composer cannot be told from a placeholder, so the older search runs. */
function bare(visible: string): DeliveryFrame {
  return { alive: true, dead: false, promptReady: false, visible };
}

function capture(name: string): DeliveryFrame {
  const visible = readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
  const [x, y] = readFileSync(join(FIXTURES, `${name}.cursor`), 'utf8')
    .trim()
    .split('|');
  return { ...bare(visible), cursorX: Number(x), cursorY: Number(y) };
}

describe('needsQueueKey', () => {
  it('should ask for the queue key when Codex offers it and the payload is still in the composer', () => {
    // Real 0.156.1 capture: `› hello` typed mid-turn, with `tab to queue message` under it.
    should(needsQueueKey(capture('codex-0.156.1-busy-typed'), 'hello', 'chars')).be.true();
  });

  it('should tolerate wording and spacing drift in the hint', () => {
    should(needsQueueKey(bare(`${TEXT}\nTab  to  Queue message`), TEXT, 'chars')).be.true();
  });

  it('should never press a blind extra key at a frame that is not holding this payload', () => {
    should(needsQueueKey(bare('  tab to queue message'), TEXT, 'chars')).be.false();
    should(needsQueueKey(bare(`${TEXT}\n${WORKING}`), TEXT, 'chars')).be.false();
    // The hint is up for a DIFFERENT draft (`hey?`), while `hello` is already pending.
    should(needsQueueKey(capture('codex-0.156.1-busy-pending-tab'), 'hello', 'chars')).be.false();
  });

  it('should read a collapsed paste by its placeholder rather than its characters', () => {
    const frame = bare('[Pasted text #1 +18 lines]\n tab to queue message');
    should(needsQueueKey(frame, TEXT, 'placeholder')).be.true();
    should(needsQueueKey(frame, TEXT, 'chars')).be.false();
  });
});

describe('queuedWhere', () => {
  it('should find the payload in the pending block of every measured Codex version', () => {
    should(queuedWhere(capture('codex-0.145.0-busy-pending'), 'hello', 'chars')).equal('queue');
    should(queuedWhere(capture('codex-0.156.1-busy-pending'), 'hello', 'chars')).equal('queue');
    should(queuedWhere(capture('codex-0.145.0-busy-pending-tab'), 'hey?', 'chars')).equal('queue');
  });

  it('should NOT call a message queued because its words are in the conversation above — the `hello` bug', () => {
    // Real 0.163.0 capture after Enter steered `hello` straight into the turn: `› hello` is history.
    should(queuedWhere(capture('codex-0.163.0-busy-pending'), 'hello', 'chars')).be.undefined();
  });

  it('should say "composer" for a payload Codex left typed', () => {
    should(queuedWhere(capture('codex-0.163.0-busy-typed'), 'hello', 'chars')).equal('composer');
  });

  it('should fall back to the whole-frame search when no composer cursor is known', () => {
    should(queuedWhere(bare(`❯ ${TEXT}`), TEXT, 'chars')).equal('composer');
    should(queuedWhere(bare('❯ '), TEXT, 'chars')).be.undefined();
  });
});

describe('queuedWhere on a real Claude Code 2.1.281 queue', () => {
  const CLAUDE = readFileSync(join(FIXTURES, 'claude-2.1.281-busy-queued-copies.txt'), 'utf8');
  /** The resend, exactly as the daemon typed it: a peer envelope and the message under it. */
  const RESEND =
    '[message from ferret lizzette (session mvgt2oz9-04e28935) — not from the owner]\n' +
    'No reply needed. To reply: fy send lizzette "<reply>"\n\n' +
    'lizzette (resend): QoS CONFIRMED as the Mac root cause — ProcessType=Interactive took the ' +
    "owner's 4.67.0 from 381 stalls/lag 3.1s to lag 0.1ms. I told rozanne to ship the plist fix first.";

  it('should prove the payload held in the queue above the spinner — the copy the daemon kept retyping', () => {
    should(queuedWhere({ ...bare(CLAUDE), cursorX: 2, cursorY: 77 }, RESEND, 'placeholder')).equal('queue');
  });

  it('should read the queue before the whole-frame fallback, which called a queued message "typed"', () => {
    // A composer with no cursor on it cannot be told from a placeholder, so the fallback runs — and the
    // payload's words ARE on screen, in the queue.
    const drafted = CLAUDE.replace('Press up to edit queued messages', 'a note somebody is typing');
    should(queuedWhere(bare(drafted), RESEND, 'chars')).equal('queue');
    should(queuedWhere(bare(CLAUDE), RESEND, 'chars')).equal('queue');
  });

  it('should never ask Claude for a queue key it does not have', () => {
    should(needsQueueKey(bare(CLAUDE), RESEND, 'chars')).be.false();
  });
});
