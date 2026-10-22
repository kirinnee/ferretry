import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  classifySubmit,
  codexUpdateAction,
  composerEvidence,
  composerContains,
  composerHolds,
  composerState,
  composerTransport,
  type DeliveryFrame,
  harnessExitReason,
  landingEvidence,
  MAX_STARTUP_DIALOG_ATTEMPTS,
  nextReadinessStep,
  PASTE_TRANSPORT_CHARS,
  paneShowsOpenPicker,
  resumeMenuAction,
  type StartupDialogAction,
  startupDialogAction,
} from '../../../src/lib/index.ts';

const IDLE: DeliveryFrame = { alive: true, dead: false, promptReady: true, visible: '> ' };
const noAttempts = new Map<StartupDialogAction['kind'], number>();

function modal(...lines: string[]): DeliveryFrame {
  return { alive: true, dead: false, promptReady: false, visible: lines.join('\n') };
}

describe('startup dialogs', () => {
  it('should take the affirmative row of every trust-style dialog it recognises', () => {
    // Arrange — each dialog with its cursor somewhere other than the row we want.
    const dialogs = {
      codexTrust: 'Do you trust the contents of this directory?\n  1. Yes, proceed\n❯ 2. No, exit',
      claudeTrust:
        'Quick safety check: is this a project you created or one you trust?\n  1. Yes, I trust this folder\n❯ 2. No',
      permissionBypass: 'Bypass permissions?\n  1. Yes, I accept\n❯ 2. No, exit',
      apiKey: 'Do you want to use this API key?\n  1. Yes, use it\n❯ 2. No',
    };

    // Act
    const actual = Object.fromEntries(Object.entries(dialogs).map(([name, pane]) => [name, startupDialogAction(pane)]));

    // Assert — one Up from row 2 to row 1, then Enter.
    should(actual).deepEqual({
      codexTrust: { kind: 'codex-trust', keys: ['Up', 'Enter'] },
      claudeTrust: { kind: 'claude-trust', keys: ['Up', 'Enter'] },
      permissionBypass: { kind: 'permission-bypass', keys: ['Up', 'Enter'] },
      apiKey: { kind: 'api-key', keys: ['Up', 'Enter'] },
    });
  });

  it('should answer the auto-mode dialog NO, the answer that keeps the mode its owner chose', () => {
    // Arrange — the dialog draws its rows without numbers; the cursor may sit on either.
    const dialog = (cursorOnYes: boolean) =>
      [
        ' Make auto mode your default permission mode?',
        '',
        `   ${cursorOnYes ? '❯' : ' '} Yes, set auto mode as my default permission mode`,
        `   ${cursorOnYes ? ' ' : '❯'} No, keep bypass permissions`,
      ].join('\n');

    // Act
    const actual = [startupDialogAction(dialog(true)), startupDialogAction(dialog(false))];

    // Assert — never Yes: that would rewrite the account's own default mode.
    should(actual).deepEqual([
      { kind: 'auto-default-nudge', keys: ['Down', 'Enter'] },
      { kind: 'auto-default-nudge', keys: ['Enter'] },
    ]);
  });

  it('should not guess at the auto-mode dialog when no cursor is drawn', () => {
    // Arrange — Enter there submits whatever is highlighted, which may be Yes.
    const pane = [
      'Make auto mode your default permission mode?',
      '  Yes, set auto mode as my default permission mode',
      '  No, keep auto mode',
    ].join('\n');

    // Act / Assert
    should(startupDialogAction(pane)).be.undefined();
  });

  it('should press Enter on the theme picker, where every row is an acceptable answer', () => {
    // Act
    const actual = [startupDialogAction('Choose the text style that looks best'), startupDialogAction('Select theme')];

    // Assert
    should(actual).deepEqual([
      { kind: 'onboarding', keys: ['Enter'] },
      { kind: 'onboarding', keys: ['Enter'] },
    ]);
  });

  it('should choose the configured resume row and never the one that changes the account', () => {
    // Arrange
    const gate = [
      'This session is 2h 45m old and 382k tokens.',
      '❯ 1. Resume from summary (recommended)',
      '  2. Resume full session as-is',
      "  3. Don't ask me again",
    ].join('\n');

    // Act
    const actual = {
      full: resumeMenuAction(gate, 'full'),
      summary: resumeMenuAction(gate, 'summary'),
      viaDefault: startupDialogAction(gate),
      notAGate: resumeMenuAction('Resume from summary only', 'full'),
    };

    // Assert
    should(actual).deepEqual({
      full: { kind: 'resume-menu', keys: ['Down', 'Enter'] },
      summary: { kind: 'resume-menu', keys: ['Enter'] },
      viaDefault: { kind: 'resume-menu', keys: ['Down', 'Enter'] },
      notAGate: undefined,
    });
  });

  it('should refuse rather than guess when the rows do not say which one is selected', () => {
    // Arrange — no cursor mark anywhere, and the row we want is not the first.
    const unmarked = 'Do you trust the contents of this directory?\n  1. No, exit\n  2. Yes, proceed';
    const unmarkedFirst = 'Do you trust the contents of this directory?\n  1. Yes, proceed\n  2. No, exit';
    const gateWithoutRows = 'Resume from summary\nResume full session as-is';

    // Act
    const actual = {
      unmarked: startupDialogAction(unmarked),
      // The harness highlights its first row by default, so the row we want is the row it has.
      unmarkedFirst: startupDialogAction(unmarkedFirst),
      noAffirmative: startupDialogAction('Do you trust the files?\n❯ 1. Maybe\n  2. Later'),
      gateWithoutRows: resumeMenuAction(gateWithoutRows, 'full'),
      notADialog: startupDialogAction('> '),
    };

    // Assert
    should(actual).deepEqual({
      unmarked: undefined,
      unmarkedFirst: { kind: 'codex-trust', keys: ['Enter'] },
      noAffirmative: undefined,
      gateWithoutRows: undefined,
      notADialog: undefined,
    });
  });
});

describe('codex folder trust screen (0.156+)', () => {
  const frame = (name: string): string =>
    readFileSync(join(import.meta.dir, '../../fixtures/harness-dialogs', `${name}.txt`), 'utf8');

  it('should trust the launch folder the fixed layer already trusts, with the cursor on its row', () => {
    // Act
    const actual = startupDialogAction(frame('codex-0.163.0-directory-trust'));

    // Assert
    should(actual).deepEqual({ kind: 'codex-trust', keys: ['Enter'] });
  });

  it('should leave a yes that would trust the whole repository to a person, on either screen', () => {
    // Arrange — the same note on the 0.145.0 question.
    const older = [
      '> You are in /home/dev/project/sub',
      '',
      '  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:',
      '  /home/dev/project',
      '',
      '  Do you trust the contents of this directory?',
      '',
      '› 1. Yes, continue',
      '  2. No, quit',
      '',
      '  Press enter to continue',
    ].join('\n');

    // Act
    const actual = [
      startupDialogAction(frame('codex-0.163.0-directory-trust-subdirectory')),
      startupDialogAction(older),
    ];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });

  it('should not open an untrusted folder restricted on anybody’s behalf', () => {
    should(startupDialogAction(frame('codex-0.163.0-directory-restricted'))).be.undefined();
  });
});

describe('codex update prompt', () => {
  const frame = (name: string): string =>
    readFileSync(join(import.meta.dir, '../../fixtures/harness-dialogs', `${name}.txt`), 'utf8');
  const UPDATES = ['codex-0.145.0-update', 'codex-0.156.1-update'];

  /** The same prompt with its cursor on row `row`. */
  const cursorOn = (pane: string, row: number): string =>
    pane
      .split('\n')
      .map(line => line.replace(/^(\s*)[›>]\s+(\d)\./u, '$1  $2.'))
      .map(line => line.replace(new RegExp(`^(\\s*)\\s\\s(${row})\\.`, 'u'), '$1› $2.'))
      .join('\n');

  it('should answer Skip on both versions’ prompts: Down to the second row, then Enter', () => {
    // Act
    const actual = UPDATES.map(name => codexUpdateAction(frame(name)));

    // Assert — never "Update now", which runs a package manager, nor "Skip until next version".
    should(actual).deepEqual(UPDATES.map(() => ({ kind: 'codex-update', keys: ['Down', 'Enter'] })));
  });

  it('should be what the startup answer picks for it', () => {
    // Act
    const actual = UPDATES.map(name => startupDialogAction(frame(name)));

    // Assert
    should(actual).deepEqual(UPDATES.map(() => ({ kind: 'codex-update', keys: ['Down', 'Enter'] })));
  });

  it('should press Enter alone when the cursor is already on Skip', () => {
    // Act
    const actual = UPDATES.map(name => codexUpdateAction(cursorOn(frame(name), 2)));

    // Assert
    should(actual).deepEqual(UPDATES.map(() => ({ kind: 'codex-update', keys: ['Enter'] })));
  });

  it('should move Up when the cursor is below Skip', () => {
    // Act
    const actual = codexUpdateAction(cursorOn(frame('codex-0.156.1-update'), 3));

    // Assert
    should(actual).deepEqual({ kind: 'codex-update', keys: ['Up', 'Enter'] });
  });

  it('should answer nothing for any other dialog or a plain prompt', () => {
    // Act
    const actual = [
      codexUpdateAction(frame('codex-0.156.1-hooks-review')),
      codexUpdateAction(frame('codex-0.156.1-sign-in')),
      codexUpdateAction('> '),
    ];

    // Assert
    should(actual).deepEqual([undefined, undefined, undefined]);
  });

  it('should answer nothing when the prompt offers no Skip row', () => {
    // Arrange
    const pane = frame('codex-0.156.1-update').replace('  2. Skip\n', '').replace('3. Skip until', '2. Skip until');

    // Act
    const actual = [codexUpdateAction(pane), startupDialogAction(pane)];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });

  it('should leave an update-shaped dialog of Claude alone', () => {
    // Arrange
    const pane = [
      '─'.repeat(40),
      '  Update available · 2.1.281 → 2.2.0',
      '',
      '❯ 1. Update now',
      '  2. Skip',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    // Act
    const actual = [codexUpdateAction(pane), startupDialogAction(pane)];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });
});

describe('composer evidence', () => {
  it('should count the payload probe rather than merely finding it somewhere on screen', () => {
    // Arrange — `continue` is routinely already in the transcript.
    const frame = 'the agent said continue earlier\n> continue';

    // Act
    const actual = {
      twice: composerEvidence(frame, 'continue').chars,
      wrapped: composerEvidence('> cont\n  inue', 'continue').chars,
      emptyProbe: composerEvidence(frame, '   ').chars,
    };

    // Assert
    should(actual).deepEqual({ twice: 2, wrapped: 1, emptyProbe: 0 });
  });

  it('should recognise every collapsed-paste placeholder both harnesses render', () => {
    // Arrange
    const frame = '> [Pasted text #2 +16 lines] [Image #1] [Pasted Content] [Audio #1] [...Truncated text here]';

    // Act
    const actual = composerEvidence(frame, 'anything at all');

    // Assert
    should(actual).deepEqual({ chars: 0, placeholders: 5, maxPlaceholderIndex: 2 });
  });

  it('should prefer a new placeholder over a character echo, and report nothing when neither moved', () => {
    // Arrange
    const none = { chars: 0, placeholders: 0, maxPlaceholderIndex: 0 };

    // Act
    const actual = {
      newPlaceholder: landingEvidence(none, { chars: 0, placeholders: 1, maxPlaceholderIndex: 1 }),
      // A second paste of the same size: the count is unchanged but its counter climbed.
      higherCounter: landingEvidence(
        { chars: 0, placeholders: 1, maxPlaceholderIndex: 1 },
        { chars: 0, placeholders: 1, maxPlaceholderIndex: 2 },
      ),
      newChars: landingEvidence(none, { chars: 1, placeholders: 0, maxPlaceholderIndex: 0 }),
      nothing: landingEvidence(none, none),
    };

    // Assert
    should(actual).deepEqual({
      newPlaceholder: 'placeholder',
      higherCounter: 'placeholder',
      newChars: 'chars',
      nothing: undefined,
    });
  });

  it('should look for the display form that proved the landing, not the other one', () => {
    // Act
    const actual = {
      charsHeld: composerHolds('> continue', 'continue', 'chars'),
      charsGone: composerHolds('> ', 'continue', 'chars'),
      placeholderHeld: composerHolds('> [Pasted text #1 +9 lines]', 'a\nb', 'placeholder'),
      // The characters are on screen, but a placeholder delivery is not proved by them.
      placeholderGone: composerHolds('> a b', 'a\nb', 'placeholder'),
    };

    // Assert
    should(actual).deepEqual({ charsHeld: true, charsGone: false, placeholderHeld: true, placeholderGone: false });
  });

  it('should paste anything multi-line or long and type everything else', () => {
    // Act
    const actual = {
      short: composerTransport('continue'),
      multiline: composerTransport('do this\nthen that'),
      long: composerTransport('x'.repeat(PASTE_TRANSPORT_CHARS + 1)),
      atTheBound: composerTransport('x'.repeat(PASTE_TRANSPORT_CHARS)),
    };

    // Assert
    should(actual).deepEqual({ short: 'literal', multiline: 'paste', long: 'paste', atTheBound: 'literal' });
  });

  it('should recognise every Codex picker, including the QUICK one a partial copy of the titles missed', () => {
    // THE THIRD ENTRY IS THE DEFECT THIS REPLACED. `/model` opens the quick picker, whose title is
    // exactly `Select Model`, and the local regex here knew only two of the five titles — so the
    // commonest outcome of the commonest runtime control classified as a started turn and the driver
    // refused every targeted Codex switch.
    // Act
    const actual = [
      paneShowsOpenPicker(['Select Model and Effort', '  1. gpt-5.6-codex'].join('\n')),
      paneShowsOpenPicker(['Select Reasoning Level for gpt-9-codex-unreleased', '  1. Low'].join('\n')),
      paneShowsOpenPicker(['Select Model', '  1. gpt-5.6-codex', '  2. All models'].join('\n')),
      paneShowsOpenPicker('> /model'),
    ];

    // Assert
    should(actual).deepEqual([true, true, true, false]);
  });

  it('should refuse a picker that has scrolled into history behind a live composer', () => {
    // A bare title match fires on any frame that MENTIONS a picker, including one already closed —
    // and `classifySubmit` reads that as "the first Enter was consumed", so a second Enter would be
    // sent into whatever now has focus. Deriving it from the parser keeps the composer-below-title
    // rule, which is the only thing that tells an open modal from its own scrollback.
    // Act
    const actual = paneShowsOpenPicker(['Select Model', '  1. gpt-5.6-codex', '> '].join('\n'));

    // Assert
    should(actual).equal(false);
  });

  it('should call a submitted /model handled-local once the quick picker is up', () => {
    // The end the defect actually broke: delivery classifying the pane the driver then preflights.
    // Arrange
    const picker: DeliveryFrame = {
      alive: true,
      dead: false,
      promptReady: false,
      visible: ['Select Model', '  1. gpt-5.6-codex', '  2. All models'].join('\n'),
    };

    // Act
    const actual = classifySubmit(picker, '/model', 'chars');

    // Assert
    should(actual).deepEqual({ kind: 'delivered', outcome: 'handled-local' });
  });
});

describe('readiness steps', () => {
  it('should report a prompt as ready and a booting pane as worth waiting for', () => {
    // Act
    const actual = [
      nextReadinessStep(IDLE, noAttempts),
      nextReadinessStep({ ...IDLE, promptReady: false, visible: 'Loading model…' }, noAttempts),
    ];

    // Assert
    should(actual).deepEqual([{ kind: 'ready' }, { kind: 'wait' }]);
  });

  it('should answer a dialog before it ever looks at readiness', () => {
    // Arrange — the modal renders a prompt line, so `promptReady` alone would say ready.
    const frame = modal('Do you trust the files?', '❯ 1. Yes, proceed', '  2. No, exit');

    // Act
    const actual = nextReadinessStep({ ...frame, promptReady: true }, noAttempts);

    // Assert
    should(actual).deepEqual({ kind: 'answer_dialog', action: { kind: 'claude-trust', keys: ['Enter'] }, attempt: 1 });
  });

  it('should stop once one kind of dialog has swallowed its whole budget', () => {
    // Arrange
    const frame = modal('Do you trust the files?', '❯ 1. Yes, proceed', '  2. No, exit');
    const spent = new Map<StartupDialogAction['kind'], number>([['claude-trust', MAX_STARTUP_DIALOG_ATTEMPTS]]);

    // Act
    const actual = nextReadinessStep(frame, spent);

    // Assert
    should(actual).deepEqual({
      kind: 'stuck',
      reason: `the claude-trust dialog did not close after ${MAX_STARTUP_DIALOG_ATTEMPTS} attempts`,
    });
  });

  it('should report an exited pane before reasoning about anything it is showing', () => {
    // Act
    const actual = [
      nextReadinessStep({ ...IDLE, alive: false, visible: '' }, noAttempts),
      nextReadinessStep({ ...IDLE, dead: true, exitCode: 137, visible: '' }, noAttempts),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'exited', reason: 'the interactive harness exited; tmux reported no exit code' },
      { kind: 'exited', reason: 'the interactive harness exited (137)' },
    ]);
  });
});

describe('harness exit reason', () => {
  it('should quote the last lines a dead pane printed, so the card says why it exited', () => {
    // Arrange
    const frame: DeliveryFrame = {
      ...IDLE,
      dead: true,
      exitCode: 2,
      visible: [
        'booting',
        '',
        'ferretry: ANTHROPIC_AUTH_TOKEN is not set — run: fy secret set DEEPSEEK_KEY',
        '\u001b[31merror:\u001b[0m unknown option',
        '',
        'Pane is dead (status 2, Tue Oct 20 10:15:03 2026)',
        '',
      ].join('\n'),
    };

    // Act
    const actual = nextReadinessStep(frame, noAttempts);

    // Assert
    should(actual).deepEqual({
      kind: 'exited',
      reason:
        'the interactive harness exited (2): its last output was "booting / ferretry: ANTHROPIC_AUTH_TOKEN is not set — run: fy secret set DEEPSEEK_KEY / error: unknown option"',
    });
  });

  it('should keep only the end of a runaway line and say nothing when the pane printed nothing', () => {
    // Act
    const actual = [
      harnessExitReason({ exitCode: 1, visible: `${'a'.repeat(400)}b` }),
      harnessExitReason({ visible: '\n  \n' }),
      // tmux redraws a dead pane's screen; what the process printed last survives in the scrollback.
      harnessExitReason({
        exitCode: 2,
        visible: 'Pane is dead (status 2)',
        history: 'err-line\nPane is dead (status 2)',
      }),
      harnessExitReason({ exitCode: 2, visible: 'on screen', history: ' \n' }),
    ];

    // Assert
    should(actual).deepEqual([
      `the interactive harness exited (1): its last output was "…${'a'.repeat(299)}b"`,
      'the interactive harness exited; tmux reported no exit code',
      'the interactive harness exited (2): its last output was "err-line"',
      'the interactive harness exited (2): its last output was "on screen"',
    ]);
  });
});

describe('submit classification', () => {
  it('should treat a turn, a dead pane, and an empty prompt as delivered', () => {
    // Act
    const actual = {
      working: classifySubmit(
        { ...IDLE, promptReady: false, visible: '✻ Thinking… (2s · ⚒ 1k tokens)' },
        'go',
        'chars',
      ),
      gone: classifySubmit({ ...IDLE, alive: false }, 'go', 'chars'),
      backAtPrompt: classifySubmit(IDLE, 'go', 'chars'),
      // Not idle, not working, and the payload is no longer on screen: it was consumed.
      consumed: classifySubmit({ ...IDLE, promptReady: false, visible: 'some local output' }, 'go', 'chars'),
    };

    // Assert
    should(actual).deepEqual({
      working: { kind: 'delivered', outcome: 'turn-started' },
      gone: { kind: 'delivered', outcome: 'turn-started' },
      backAtPrompt: { kind: 'delivered', outcome: 'handled-local' },
      consumed: { kind: 'delivered', outcome: 'turn-started' },
    });
  });

  it('should call a model selector delivered rather than pressing Enter into it again', () => {
    // Arrange — the frame still echoes `/model`, which the character probe cannot tell from a
    // composer that still holds it.
    const frame: DeliveryFrame = {
      alive: true,
      dead: false,
      promptReady: false,
      visible: '› /model\nSelect Model and Effort\n  1. gpt-5-codex',
    };

    // Act
    const actual = classifySubmit(frame, '/model', 'chars');

    // Assert
    should(actual).deepEqual({ kind: 'delivered', outcome: 'handled-local' });
  });

  it('should report a payload still sitting in the composer as not yet delivered', () => {
    // Act
    const actual = classifySubmit({ ...IDLE, promptReady: false, visible: '> go' }, 'go', 'chars');

    // Assert
    should(actual).deepEqual({ kind: 'holding' });
  });
});

describe('submit classification read from the composer', () => {
  const capture = (state: string): DeliveryFrame => {
    const dir = join(import.meta.dir, '../../fixtures/composer');
    const [x, y] = readFileSync(join(dir, `codex-0.156.1-${state}.cursor`), 'utf8')
      .trim()
      .split('|');
    const visible = readFileSync(join(dir, `codex-0.156.1-${state}.txt`), 'utf8');
    return { alive: true, dead: false, promptReady: false, visible, cursorX: Number(x), cursorY: Number(y) };
  };

  it('should hold while a swallowed Enter left the payload in a two-line composer', () => {
    // Real capture: Enter arrived inside Codex's paste-burst window and opened a new line instead.
    should(classifySubmit(capture('idle-typed-newline'), 'fix the flaky testx', 'chars')).deepEqual({
      kind: 'holding',
    });
  });

  it('should call a payload delivered once the composer is back to its placeholder, though it is echoed above', () => {
    // Arrange — `hi` is all over this frame (`› hihello` in history, `anything` in the placeholder),
    // which the whole-frame search read as "still in the composer".
    const frame = capture('idle-empty');

    should(classifySubmit(frame, 'hi', 'chars')).deepEqual({ kind: 'delivered', outcome: 'turn-started' });
  });

  it('should hold a collapsed paste until the composer lets it go', () => {
    const pasted: DeliveryFrame = {
      alive: true,
      dead: false,
      promptReady: false,
      visible: '› [Pasted Content 900 chars]',
      cursorX: 29,
      cursorY: 0,
    };

    should(classifySubmit(pasted, 'z'.repeat(900), 'placeholder')).deepEqual({ kind: 'holding' });
    should(classifySubmit({ ...pasted, visible: '› ' }, 'z'.repeat(900), 'placeholder')).deepEqual({
      kind: 'delivered',
      outcome: 'turn-started',
    });
  });
});

describe('the composer state a fill may type into', () => {
  const POINTER =
    'Read the file /Users/erng/.ferretry/state/sessions/s/turns/turn-026.md now, then carefully follow every ' +
    'instruction inside it. This is your complete task for this turn.';
  const at = (visible: string, cursorX?: number, cursorY?: number): DeliveryFrame => ({
    alive: true,
    dead: false,
    promptReady: false,
    visible,
    ...(cursorX === undefined ? {} : { cursorX, cursorY }),
  });

  it('should be empty for a blank composer and for a placeholder the cursor or its wording proves', () => {
    should(composerState(at('───\n❯ \n───', 2, 1))).deepEqual({ kind: 'empty' });
    should(composerState(at('───\n❯ \n───'))).deepEqual({ kind: 'empty' }, 'nothing drawn is nothing typed');
    should(composerState(at('❯ Try "fix lint errors"', 2, 0))).deepEqual({ kind: 'empty' });
    should(composerState(at('❯ Try "fix lint errors"'))).deepEqual({ kind: 'empty' });
  });

  it('should be input only where the cursor proves the text typed', () => {
    should(composerState(at('❯ my own words', 14, 0))).deepEqual({ kind: 'input', text: 'my own words' });
  });

  it('should be unreadable — never empty — for text no cursor places, or a frame with no composer', () => {
    should(composerState(at('❯ my own words'))).deepEqual({ kind: 'unreadable' });
    should(composerState(at('❯ my own words\n\n\n', 0, 3))).deepEqual({ kind: 'unreadable' });
    // Somebody's draft that merely starts like a suggestion is not one: it runs onto a second row.
    should(composerState(at('❯ Try "this" and then\n  that'))).deepEqual({ kind: 'unreadable' });
    should(composerState(at('Loading model…'))).deepEqual({ kind: 'unreadable' });
  });

  it('should hold a submit while the pointer sits after other text, rather than call it consumed', () => {
    const frame = at(`❯ my question?${POINTER}`, 30, 0);

    should(classifySubmit(frame, POINTER, 'chars')).deepEqual({ kind: 'holding' });
    should(composerContains(`my question?${POINTER}`, POINTER)).be.true();
    should(composerContains('a hint of this', 'hint')).be.false();
    should(composerContains('hint', 'hint')).be.true();
  });
});
