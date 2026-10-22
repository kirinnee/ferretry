import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { peerEnvelopePreamble } from '@ferretry/protocol';
import should from 'should';
import {
  type ComposerCursor,
  composerInput,
  composerLanding,
  composerState,
  type DeliveryFrame,
  heldAt,
  occupiedComposer,
  paneHoldOf,
  readComposer,
  readHarnessQueue,
  readPendingInputs,
  showsPayload,
} from '../../../src/lib/index.ts';

/**
 * What a Codex composer holds, read from REAL pane captures.
 *
 * Every fixture under `tests/fixtures/composer/` is a `capture-pane -p` of a real Codex TUI (0.145.0,
 * 0.156.1, 0.163.0) driven against a local fake model API, with `#{cursor_x}|#{cursor_y}` beside it.
 * The states are the ones the bug lived in: an idle composer showing its placeholder, a typed draft, a
 * draft a swallowed Enter turned into two lines, and a busy pane holding messages in its pending block.
 */

const VERSIONS = ['0.145.0', '0.156.1', '0.163.0'] as const;
const FIXTURES = join(import.meta.dir, '../../fixtures/composer');

function capture(version: string, state: string): DeliveryFrame {
  const visible = readFileSync(join(FIXTURES, `codex-${version}-${state}.txt`), 'utf8');
  const [x, y] = readFileSync(join(FIXTURES, `codex-${version}-${state}.cursor`), 'utf8')
    .trim()
    .split('|');
  return { alive: true, dead: false, promptReady: false, visible, cursorX: Number(x), cursorY: Number(y) };
}

function cursorOf(frame: DeliveryFrame): { x?: number; y?: number } {
  return { x: frame.cursorX, y: frame.cursorY };
}

describe('readComposer on real Codex captures', () => {
  for (const version of VERSIONS) {
    it(`should read the ${version} placeholder as a placeholder, whatever words it uses`, () => {
      // Arrange — 0.145 rotates to `Run /review on my current changes`, the later ones show
      // `Ask Codex to do anything`; both contain words a short message is made of.
      const frame = capture(version, 'idle-empty');

      // Act
      const composer = readComposer(frame.visible, cursorOf(frame));

      // Assert
      should(composer?.placeholder).be.true();
      should(composerInput(composer)).equal('');
      should(occupiedComposer(frame)).be.undefined();
    });

    it(`should read a ${version} typed draft as input, and a draft a swallowed Enter split as input too`, () => {
      const typed = capture(version, 'idle-typed');
      const split = capture(version, 'idle-typed-newline');

      should(readComposer(typed.visible, cursorOf(typed))).deepEqual({
        text: 'fix the flaky test',
        placeholder: false,
        pasted: false,
      });
      // The cursor sits on the blank row the newline opened, one row below the text.
      should(readComposer(split.visible, cursorOf(split))?.placeholder).be.false();
      should(occupiedComposer(typed)).equal('fix the flaky test');
    });

    it(`should find nothing typed after a ${version} composer was cleared`, () => {
      const frame = capture(version, 'after-clear');
      should(occupiedComposer(frame)).be.undefined();
    });
  }
});

describe('readPendingInputs on real Codex captures', () => {
  it('should read the messages a busy Codex holds above its composer, in order', () => {
    should(readPendingInputs(capture('0.145.0', 'busy-pending-tab').visible)).deepEqual(['hello', 'hey?']);
    should(readPendingInputs(capture('0.156.1', 'busy-pending').visible)).deepEqual(['hello']);
  });

  it('should read no queue where there is none, including a frame with no composer at all', () => {
    should(readPendingInputs(capture('0.163.0', 'busy-pending').visible)).deepEqual([]);
    should(readPendingInputs('• Working (3s • esc to interrupt)\n  ↳ stale')).deepEqual(['stale']);
    should(readPendingInputs('')).deepEqual([]);
  });

  it('should stop at the conversation above a pending block', () => {
    // Arrange — an arrow that scrolled up with the conversation is history.
    const frame = ['  ↳ old entry', '• ack 3: done', '', '• Queued follow-up inputs', '  ↳ new one', '', '› '].join(
      '\n',
    );

    should(readPendingInputs(frame)).deepEqual(['new one']);
  });

  it('should join an entry that wrapped onto deeper-indented rows', () => {
    const frame = ['• Queued follow-up inputs', '  ↳ please read the brief', '    and then report back', '', '› '].join(
      '\n',
    );

    should(readPendingInputs(frame)).deepEqual(['please read the brief and then report back']);
  });
});

describe('heldAt', () => {
  it('should say "queue" only for the pending block and never for the conversation above it', () => {
    // Arrange — 0.156.1 shows `› hihello` in its history AND `↳ hello` pending.
    const frame = capture('0.156.1', 'busy-pending');

    should(heldAt(frame.visible, cursorOf(frame), 'hello', false)).equal('queue');
    should(heldAt(frame.visible, cursorOf(frame), 'hihello', false)).be.undefined();
  });

  it('should say "composer" for a typed draft and nothing for words the placeholder happens to contain', () => {
    const typed = capture('0.163.0', 'busy-typed');
    const empty = capture('0.156.1', 'idle-empty');

    should(heldAt(typed.visible, cursorOf(typed), 'hello', false)).equal('composer');
    should(heldAt(empty.visible, cursorOf(empty), 'hi', false)).be.undefined();
  });

  it('should count a collapsed paste in the composer as the pasted payload', () => {
    const frame = '› [Pasted Content 1204 chars]\n\n  gpt-5 default';
    const cursor = { x: 30, y: 0 };

    should(heldAt(frame, cursor, 'x'.repeat(1204), true)).equal('composer');
    should(heldAt(frame, cursor, 'x'.repeat(1204), false)).be.undefined();
  });
});

describe('composerLanding', () => {
  it('should prove a payload by the composer showing exactly it', () => {
    should(composerLanding(capture('0.156.1', 'idle-typed'), 'fix the flaky test', false)).equal('chars');
  });

  it('should prove nothing from a placeholder that contains the payload — the `hi` bug', () => {
    should(composerLanding(capture('0.156.1', 'idle-empty'), 'hi', false)).be.undefined();
    should(composerLanding(capture('0.145.0', 'idle-empty'), 'review', false)).be.undefined();
  });

  it('should take a collapsed paste as the paste it is', () => {
    const frame: DeliveryFrame = {
      alive: true,
      dead: false,
      promptReady: false,
      visible: '› [Pasted Content 900 chars]',
      cursorX: 28,
      cursorY: 0,
    };

    should(composerLanding(frame, 'y'.repeat(900), true)).equal('placeholder');
    should(composerLanding({ ...frame, visible: '› something else' }, 'y'.repeat(900), true)).be.undefined();
  });

  it('should say "unreadable" when there is no composer or no cursor on it', () => {
    should(composerLanding({ alive: true, dead: false, promptReady: false, visible: 'booting' }, 'hi', false)).equal(
      'unreadable',
    );
    should(composerLanding({ alive: true, dead: false, promptReady: false, visible: '› hi' }, 'hi', false)).equal(
      'unreadable',
    );
  });
});

describe('readComposer edge shapes', () => {
  it('should read a boxed composer and stop at its closing rule', () => {
    const frame = ['╭────────╮', '│ > hello │', '╰────────╯'].join('\n');

    should(readComposer(frame, { x: 9, y: 1 })).deepEqual({ text: 'hello', placeholder: false, pasted: false });
  });

  it('should read a multi-line draft up to the blank row above the footer', () => {
    // A small multi-line paste is drawn as its lines (Codex 0.156.1, measured), wrapped rows indented.
    const frame = ['› line1', '  line2', '  line3 xxx', '', '  gpt-5 default · ~/work'].join('\n');

    should(readComposer(frame, { x: 12, y: 2 })).deepEqual({
      text: 'line1\nline2\nline3 xxx',
      placeholder: false,
      pasted: false,
    });
  });

  it('should treat an empty prompt as empty and a numbered selector as no composer', () => {
    should(readComposer('› ', { x: 2, y: 0 })).deepEqual({ text: '', placeholder: false, pasted: false });
    should(readComposer('› 1. Yes, proceed', { x: 2, y: 0 })).be.undefined();
  });

  it('should not claim a placeholder when the cursor is elsewhere on screen', () => {
    should(readComposer('› Ask Codex to do anything', { x: 0, y: 9 })?.placeholder).be.undefined();
  });
});

describe('showsPayload', () => {
  it('should ignore how the TUI wrapped the text', () => {
    should(showsPayload('fix the\nflaky test', 'fix the flaky test')).be.true();
  });

  it('should match a long entry the harness clipped, but never a short one', () => {
    should(showsPayload('please read the attached…', 'please read the attached brief carefully')).be.true();
    should(showsPayload('ok…', 'ok then, carry on')).be.false();
    should(showsPayload('hello there', 'hello')).be.false();
  });

  it('should never match empty text', () => {
    should(showsPayload('', 'hi')).be.false();
    should(showsPayload('hi', ' ')).be.false();
  });
});

/**
 * Claude Code 2.1.281's queue, read from REAL pane captures of the incident: one `fy send` typed four
 * times into a mid-turn Claude ferret, because the daemon did not recognise this rendering as holding
 * it. The captures carry no cursor, so every claim is checked under each cursor tmux could report.
 */
describe('Claude Code 2.1.281 queue on real captures', () => {
  const COMPOSER_ROW = 77;
  const CURSORS: ReadonlyArray<{ readonly name: string; readonly cursor: ComposerCursor }> = [
    { name: 'no cursor', cursor: {} },
    { name: 'the cursor at the placeholder', cursor: { x: 2, y: COMPOSER_ROW } },
    { name: 'the cursor past the placeholder', cursor: { x: 34, y: COMPOSER_ROW } },
    { name: 'the cursor on the row below', cursor: { x: 0, y: COMPOSER_ROW + 1 } },
  ];

  const envelope = (name: string, session: string): string =>
    peerEnvelopePreamble({ name, sessionId: session, kind: 'message', clientName: 'fy' });
  const LIZZETTE = envelope('lizzette', 'mvgt2oz9-04e28935');
  const CONFIRMED =
    `${LIZZETTE}lizzette: CONFIRMED on the owner's Mac — after manual ProcessType=Interactive ` +
    '(spawn type = interactive (4)), 4.67.0: lag 0.1ms, 1 stall total (0.4s at boot, dlopen of WebRTC lib) ' +
    'vs 381 stalls/worst 7.9s/lag 3.1s minutes earlier on the same build. QoS was the root cause. Please make ' +
    "sure rozanne's plist fix ships ASAP (and that update/restart never drops the key).";
  const RESEND =
    `${LIZZETTE}lizzette (resend): QoS CONFIRMED as the Mac root cause — ProcessType=Interactive took the ` +
    "owner's 4.67.0 from 381 stalls/lag 3.1s to lag 0.1ms. I told rozanne to ship the plist fix first.";
  const ROOT_CAUSE =
    `${LIZZETTE}lizzette: CONFIRMED root cause on the owner's Mac — manual ProcessType=Interactive took ` +
    '4.67.0 from 381 stalls / worst 7.9s / lag 3.1s to lag 0.1ms, 1 boot-only stall. Ship the plist fix ' +
    "first (own PR if the cleanups aren't ready), and make sure update/restart/install never drop the key.";
  const LEAD =
    `${envelope('sheilah', 'mvir1r5g-90731a4e')}lead: thanks for #706 — good call keeping load() fresh for ` +
    'authority. The per-string redaction follow-up is the biggest remaining secrets.key source on the live ' +
    'box (6.1/s on the operator read path: events/messages rows, triage). Could you take it as your next PR ' +
    '(one vault open per read batch/request, or an identity-keyed ciphertext cache — never plaintext)? ' +
    "I'm at my sub-ferret limit. If you can't, tell me and I'll queue it.";

  const claude = (state: string): string =>
    readFileSync(join(FIXTURES, `claude-2.1.281-busy-queued-${state}.txt`), 'utf8');

  it('should read every queued message above the spinner, in order, as the harness drew it', () => {
    const queue = readHarnessQueue(claude('copies'));

    should(queue.entries).have.length(8);
    for (const entry of queue.entries.slice(0, 4)) should(showsPayload(entry, CONFIRMED)).be.true();
    for (const entry of queue.entries.slice(4)) should(showsPayload(entry, RESEND)).be.true();
    should(readPendingInputs(claude('copies'))).deepEqual(queue.entries);
  });

  for (const { name, cursor } of CURSORS) {
    it(`should call the payload held in the queue, with ${name}`, () => {
      should(heldAt(claude('copies'), cursor, CONFIRMED, true)).equal('queue');
      should(paneHoldOf(claude('copies'), cursor, RESEND, true)).equal('queue');
      should(paneHoldOf(claude('clipped'), cursor, ROOT_CAUSE, true)).equal('queue');
      should(paneHoldOf(claude('clipped'), cursor, LEAD, true)).equal('queue');
    });

    it(`should never read "Press up to edit queued messages" as a typed draft, with ${name}`, () => {
      const frame: DeliveryFrame = {
        alive: true,
        dead: false,
        promptReady: false,
        visible: claude('copies'),
        ...(cursor.x === undefined ? {} : { cursorX: cursor.x, cursorY: cursor.y }),
      };
      const composer = readComposer(frame.visible, cursor);

      should(composer?.text).equal('Press up to edit queued messages');
      should(composer?.placeholder).be.true();
      should(composerInput(composer)).equal('');
      should(occupiedComposer(frame)).be.undefined();
      should(composerLanding(frame, CONFIRMED, true)).be.undefined();
    });
  }

  it('should say UNKNOWN, never absent, for a payload the clipped top of the queue could be hiding', () => {
    // Both captures start inside the queue: whatever scrolled off above may be this payload.
    const unseen = `${LIZZETTE}a message the pane does not show`;

    should(readHarnessQueue(claude('clipped')).complete).be.false();
    should(paneHoldOf(claude('clipped'), {}, unseen, true)).equal('unknown');
    should(paneHoldOf(claude('copies'), {}, unseen, true)).equal('unknown');
    should(heldAt(claude('clipped'), {}, unseen, true)).be.undefined();
  });

  it('should read a whole queue as complete, and the person’s past prompts above it as history', () => {
    const tail = claude('copies').split('\n').slice(70).join('\n');
    const frame = [
      '❯ the old prompt this turn answers',
      '',
      '⏺ Working on it.',
      '  ⎿  Read 3 files',
      '',
      '❯ check the queue too',
      '  ctrl+x ctrl+s to send now',
      '',
      tail.slice(tail.indexOf('✽')),
    ].join('\n');

    should(readHarnessQueue(frame)).deepEqual({ entries: ['check the queue too'], complete: true });
    should(paneHoldOf(frame, {}, 'check the queue too', false)).equal('queue');
    should(paneHoldOf(frame, {}, 'the old prompt this turn answers', false)).equal('absent');
  });

  it('should say UNKNOWN when the composer says messages are queued but no queue can be read', () => {
    // A rendering drift that moved or reworded the hint: the placeholder alone proves a queue exists.
    const frame = claude('copies').replace('ctrl+x ctrl+s to send now', 'something new');

    should(readHarnessQueue(frame)).deepEqual({ entries: [], complete: false });
    should(paneHoldOf(frame, {}, CONFIRMED, true)).equal('unknown');
  });

  it('should leave Codex’s pending block exactly as it read before, and complete', () => {
    for (const version of VERSIONS) {
      const frame = capture(version, 'busy-pending');
      should(readHarnessQueue(frame.visible).complete).be.true();
      should(readHarnessQueue(frame.visible).entries).deepEqual(readPendingInputs(frame.visible));
    }
    should(paneHoldOf(capture('0.156.1', 'busy-pending').visible, {}, 'hello', false)).equal('queue');
    // 0.163.0 steered `hello` into the turn: absent from the queue, and provably so.
    const steered = capture('0.163.0', 'busy-pending');
    should(paneHoldOf(steered.visible, cursorOf(steered), 'hello', false)).equal('absent');
  });
});

/**
 * A NAMED Claude Code session — `claude -n "[Aime] MXO OCI Migration"` — read from live 2.1.281
 * captures at the 82 columns of the incident pane, plus the incident's own frame rebuilt from the
 * owner's screenshot: one person's question with SIX copies of one turn pointer typed onto it.
 */
describe('the composer of a titled Claude Code session', () => {
  const POINTER =
    'Read the file /Users/erng/.ferretry/state/sessions/mvgf1elu-2a90237a/turns/turn-026.md now, then ' +
    'carefully follow every instruction inside it. This is your complete task for this turn.';
  const DRAFT =
    "before contiuing, i need to know -- for OCI's warpstream agent -- say they need to talk to OOS " +
    "(OCI's s3), where do i get the permission?";

  function titled(state: string): DeliveryFrame {
    const name = state === 'screenshot' ? 'claude-pileup-screenshot' : `claude-2.1.281-titled-${state}`;
    const visible = readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
    const [x, y] = readFileSync(join(FIXTURES, `${name}.cursor`), 'utf8')
      .trim()
      .split('|');
    return { alive: true, dead: false, promptReady: false, visible, cursorX: Number(x), cursorY: Number(y) };
  }

  const squeeze = (value: string): string => value.replace(/\s+/gu, '');
  const withoutCursor = (frame: DeliveryFrame): DeliveryFrame => {
    const { cursorX: _x, cursorY: _y, ...rest } = frame;
    return rest;
  };

  it('should read past the title in the rule above it, to the suggestion an empty composer shows', () => {
    const empty = titled('idle-empty');

    should(empty.visible).containEql('[Aime] MXO OCI Migration');
    should(readComposer(empty.visible, cursorOf(empty))?.placeholder).be.true();
    should(composerState(empty)).deepEqual({ kind: 'empty' });
    // The suggestion's own wording proves it is a placeholder when tmux reports no cursor.
    should(composerState(withoutCursor(empty))).deepEqual({ kind: 'empty' });
  });

  it("should read the person's two-row question as their draft under the titled rule", () => {
    const draft = titled('idle-draft');

    should(squeeze(occupiedComposer(draft) ?? '')).equal(squeeze(DRAFT));
    should(composerState(draft)).have.property('kind', 'input');
  });

  it('should call a composer whose cursor cannot place it unreadable, never empty', () => {
    const draft = titled('idle-draft');
    const elsewhere = { ...draft, cursorX: 0, cursorY: draft.visible.split('\n').length - 2 };

    should(occupiedComposer(withoutCursor(draft))).be.undefined();
    should(composerState(withoutCursor(draft))).deepEqual({ kind: 'unreadable' });
    should(composerState(elsewhere)).deepEqual({ kind: 'unreadable' });
  });

  it('should find a pointer typed after a draft IN the composer, so it is never typed again', () => {
    const typed = titled('draft-pointer');

    should(squeeze(occupiedComposer(typed) ?? '')).equal(squeeze(DRAFT + POINTER));
    // Exact equality said "absent" here, and absent is what licensed every retype.
    should(paneHoldOf(typed.visible, cursorOf(typed), POINTER, false)).equal('composer');
    should(paneHoldOf(typed.visible, {}, POINTER, false)).equal('composer');
    should(heldAt(typed.visible, cursorOf(typed), POINTER, false)).equal('composer');
    // A short payload that happens to be a word of the draft is not claimed.
    should(paneHoldOf(typed.visible, cursorOf(typed), 'permission', false)).equal('absent');
  });

  it('should show that C-u erased only the last wrapped row, leaving a clipped pointer behind', () => {
    // Measured live: one `C-u` took `for this turn.` and nothing else. A clear-and-retype on top of
    // that is the screenshot's `This is your Read the file`.
    const after = titled('draft-pointer-after-cu');
    const text = occupiedComposer(after) ?? '';

    should(squeeze(text)).equal(squeeze(`${DRAFT}${POINTER}`.replace(/for this turn\.$/u, '')));
    should(paneHoldOf(after.visible, cursorOf(after), POINTER, false)).equal('absent');
  });

  it("should read the incident frame as the person's draft with the pointer held, from any cursor", () => {
    const pileup = titled('screenshot');
    const text = readComposer(pileup.visible, cursorOf(pileup))?.text ?? '';

    should(squeeze(text).startsWith(squeeze(DRAFT))).be.true();
    should(squeeze(text).split(squeeze(POINTER)).length - 1).equal(5, 'five whole copies, and one clipped');
    should(composerState(pileup)).have.property('kind', 'input');
    should(composerState(withoutCursor(pileup))).deepEqual({ kind: 'unreadable' });
    should(paneHoldOf(pileup.visible, cursorOf(pileup), POINTER, false)).equal('composer');
    should(paneHoldOf(pileup.visible, {}, POINTER, false)).equal('composer');
  });
});

describe("the owner's Mac Claude pane: a draft, a titled rule, and an auto-compact line", () => {
  /**
   * `capture-pane` of the owner's Mac ferret (Claude Code 2.1.281, tmux 3.6a), trimmed to the composer
   * and its status lines: the person's unsent `go ahead with all three` after a `❯` and a no-break
   * space, the session title in the rule above, and a right-aligned `2% until auto-compact` under the
   * status lines — the line a 200k-context session shows near compaction, and the 1M sessions this was
   * first measured on never draw.
   */
  const MAC = readFileSync(join(FIXTURES, 'claude-2.1.281-mac-draft-autocompact.txt'), 'utf8');
  const ROW = MAC.split('\n').findIndex(line => line.startsWith('❯'));
  const at = (visible: string, cursorX?: number, cursorY?: number): DeliveryFrame => ({
    alive: true,
    dead: false,
    promptReady: false,
    visible,
    ...(cursorX === undefined ? {} : { cursorX }),
    ...(cursorY === undefined ? {} : { cursorY }),
  });

  it('should read the person’s draft as input, the status lines under it changing nothing', () => {
    const frame = at(MAC, 25, ROW);

    should(composerState(frame)).deepEqual({ kind: 'input', text: 'go ahead with all three' });
    should(occupiedComposer(frame)).equal('go ahead with all three');
  });

  it('should hold for any status line Claude draws there instead', () => {
    for (const line of ['14% until auto-compact', 'Context low · Run /compact to compact & continue', ''])
      should(composerState(at(MAC.replace('2% until auto-compact', line), 25, ROW))).deepEqual({
        kind: 'input',
        text: 'go ahead with all three',
      });
  });

  it('should never call that text a placeholder — EMPTY — when the cursor sits at the start of its row', () => {
    // Claude draws only `Try "…"` and `Press up to edit queued messages` as placeholders. Read as
    // empty, this draft would be typed onto, the send's own echo hidden the same way, and typed again.
    for (const column of [0, 2]) {
      should(composerState(at(MAC, column, ROW))).deepEqual({ kind: 'unreadable' });
      should(composerLanding(at(MAC, column, ROW), 'go ahead with all three', false)).equal('unreadable');
    }
    // Its own suggestion is still a placeholder, cursor or not.
    should(composerState(at(MAC.replace('go ahead with all three', 'Try "fix lint errors"'), 2, ROW))).deepEqual({
      kind: 'empty',
    });
  });
});
