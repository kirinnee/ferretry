import { describe, it } from 'bun:test';
import should from 'should';
import { paneShowsActiveWork, paneShowsPermissionPrompt, promptIsReady } from '../../../src/lib/index.ts';

/**
 * Frames taken from the two harnesses this daemon launches. The point of every case here is that a
 * WRONG answer sends keystrokes into a live turn or a modal, so each one names the screen it is.
 */
describe('pane active-work evidence', () => {
  it('should read every shape of active turn both harnesses render', () => {
    // Arrange
    const busy = {
      codexInterruptHint: 'Working (6m52s • Esc to interrupt)',
      claudeInterruptHint: '  ⏵⏵ accept edits on (shift+tab)   ctrl+c to interrupt',
      codexElapsedClipped: '• Working (12s',
      claudeElapsedWithTokens: '✻ Lollygagging… (34s · ⚒ 2.1k tokens)',
      claudeElapsedSpaced: '(5m 45s · ↓ 17.2k tokens)',
      tokenCounterAlone: '17.2k tokens · esc',
      spinnerPhrase: '✢ Fixing the stall detector so it stops lying…',
      spinnerMark: '⏺ Searching…',
    };

    // Act
    const actual = Object.fromEntries(Object.entries(busy).map(([name, frame]) => [name, paneShowsActiveWork(frame)]));

    // Assert
    should(actual).deepEqual(
      Object.fromEntries(Object.keys(busy).map(name => [name, true])),
      'every rendered active turn must read as busy',
    );
  });

  it('should refuse the idle frames that merely look like work', () => {
    // Arrange
    const idle = {
      // Codex prints this footer permanently WHILE IDLE whenever a background terminal exists.
      backgroundTerminalFooter: '1 background terminal running\n> ',
      // A tool RESULT truncation ellipsis, not a spinner.
      truncatedToolResult: '⏺ Read 400 lines from a very long file and then some more text…',
      // A parenthesised duration with no counter separator is prose, not a status line.
      proseDuration: 'the deploy took (45s) end to end',
      emptyPrompt: '> ',
    };

    // Act
    const actual = Object.fromEntries(Object.entries(idle).map(([name, frame]) => [name, paneShowsActiveWork(frame)]));

    // Assert
    should(actual).deepEqual(
      Object.fromEntries(Object.keys(idle).map(name => [name, false])),
      'an idle frame must never read as busy',
    );
  });
});

describe('pane readiness', () => {
  it('should refuse every startup modal a harness parks on, even when it renders a prompt line', () => {
    // Arrange — each modal, with a prompt-shaped line under it exactly as the TUI draws it.
    const modals = [
      'Do you trust the contents of this directory?\n❯ 1. Yes, proceed\n  2. No, exit\n> ',
      'Do you trust the files in this folder?\n> ',
      'Quick safety check: is this a project you created or one you trust?\n> ',
      'Yes, I trust this folder\n> ',
      'Press enter to continue\n> ',
      'Choose the text style that looks best\n> ',
      'Select theme\n> ',
      'Yes, I accept the risk\nNo, exit\n> ',
      'Invalid API key · Please run /login\n> ',
      'Detected a custom API key in your environment\n> ',
      'Do you want to use this API key?\n> ',
      'Sign in to continue\n> ',
      'Log in with your account\n> ',
    ];

    // Act
    const ready = modals.filter(frame => promptIsReady(frame));

    // Assert
    should(ready).deepEqual([], 'no startup modal may be reported as ready to accept a turn');
  });

  it('should treat the post-interrupt banner as ready and a live turn as not', () => {
    // Act
    const actual = {
      interrupted: promptIsReady('Tell the model what to do differently'),
      working: promptIsReady('✻ Lollygagging… (34s · ⚒ 2.1k tokens)\n> '),
    };

    // Assert
    should(actual).deepEqual(
      { interrupted: true, working: false },
      'a stopped turn is editable; a running one must never be typed into',
    );
  });

  it('should trust the cursor line when tmux reports one and fall back to the tail otherwise', () => {
    // Arrange
    const frame = ['scrollback line', '│ > ', '  2. an option'].join('\n');

    // Act
    const actual = {
      atPrompt: promptIsReady(frame, 1, 2),
      cursorPastComposer: promptIsReady(frame, 1, 9),
      cursorOnNumberedRow: promptIsReady(frame, 2, 0),
      cursorOutOfRange: promptIsReady(frame, 99, 0),
      noCursor: promptIsReady(frame),
      noPromptAnywhere: promptIsReady('just some output\nand more of it'),
    };

    // Assert
    should(actual).deepEqual(
      {
        atPrompt: true,
        cursorPastComposer: false,
        cursorOnNumberedRow: false,
        cursorOutOfRange: true,
        noCursor: true,
        noPromptAnywhere: false,
      },
      'readiness follows the cursor when tmux reports one, and the last 30 lines when it does not',
    );
  });
});

describe('paneShowsPermissionPrompt', () => {
  it("should recognise Claude's and Codex's permission prompts", () => {
    const claude = [
      '⏺ Bash(rm -rf build)',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again for rm commands',
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const codex = [
      'Would you like to run the following command?',
      '  $ git push',
      '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently',
    ].join('\r\n');
    should(paneShowsPermissionPrompt(claude)).be.true();
    should(paneShowsPermissionPrompt(codex)).be.true();
  });

  it('should not read prose, a lone choice, or a list without a question as a prompt', () => {
    should(paneShowsPermissionPrompt('Do you want to know more? I can explain.')).be.false();
    should(paneShowsPermissionPrompt('Do you want to proceed?\n❯ 1. Yes')).be.false();
    should(paneShowsPermissionPrompt('Steps:\n1. build\n2. test\n3. ship')).be.false();
  });

  it('should ignore a prompt that has scrolled out of the bottom of the frame', () => {
    const old = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
    should(paneShowsPermissionPrompt([old, ...Array.from({ length: 30 }, () => 'output')].join('\n'))).be.false();
  });
});

describe('paneShowsPermissionPrompt on a tall pane', () => {
  it('should find a prompt drawn near the top of a pane padded with blank rows', () => {
    const frame = `Do you want to proceed?\n❯ 1. Yes\n  2. No${'\n'.repeat(40)}`;
    should(paneShowsPermissionPrompt(frame)).be.true();
  });
});
