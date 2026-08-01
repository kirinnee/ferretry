import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifySubmit,
  composerEvidence,
  composerHolds,
  composerTransport,
  landingEvidence,
  MAX_STARTUP_DIALOG_ATTEMPTS,
  nextReadinessStep,
  paneShowsModelSelector,
  PASTE_TRANSPORT_CHARS,
  resumeMenuAction,
  startupDialogAction,
  type DeliveryFrame,
  type StartupDialogAction,
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

  it("should recognise Codex's model selector, including a model name it has never heard of", () => {
    // Act
    const actual = [
      paneShowsModelSelector('Select Model and Effort'),
      paneShowsModelSelector('Select Reasoning Level for gpt-9-codex-unreleased'),
      paneShowsModelSelector('> /model'),
    ];

    // Assert
    should(actual).deepEqual([true, true, false]);
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
      nextReadinessStep({ ...IDLE, alive: false }, noAttempts),
      nextReadinessStep({ ...IDLE, dead: true, exitCode: 137 }, noAttempts),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'exited', reason: 'the interactive harness exited; tmux reported no exit code' },
      { kind: 'exited', reason: 'the interactive harness exited (137)' },
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
