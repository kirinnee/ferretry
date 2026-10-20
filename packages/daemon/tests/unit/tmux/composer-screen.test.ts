import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  composerInput,
  composerLanding,
  type DeliveryFrame,
  heldAt,
  occupiedComposer,
  readComposer,
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
