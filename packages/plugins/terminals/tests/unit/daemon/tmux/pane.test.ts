import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  paneActiveWork,
  paneBlockingPrompt,
  paneShowsActiveWork,
  paneShowsPermissionPrompt,
  promptIsReady,
} from '../../../src/lib/index.ts';

/** Claude 2.1.281's one-shot auto-mode dialog, as a bypass agent showed it: rows with no numbers. */
const AUTO_NUDGE = [
  ' Make auto mode your default permission mode?',
  '',
  '   Auto mode lets Claude handle permission prompts automatically.',
  '',
  '   ❯ Yes, set auto mode as my default permission mode',
  '     No, keep bypass permissions',
].join('\n');

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
      'Trust this folder? Codex can read, edit, and run files here\n> ',
      'Skills still load. Opening will not change saved trust.\n> ',
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

describe('paneBlockingPrompt', () => {
  it('should name the auto-mode dialog a bypass agent was parked on', () => {
    should(paneBlockingPrompt(AUTO_NUDGE)).equal('Make auto mode your default permission mode?');
  });

  it('should name each harness dialog in the words a person is shown for it', () => {
    // Act
    const actual = [
      'Switch your default effort to medium?\n❯ Yes, use medium effort by default',
      'Try the new fullscreen renderer?\n  Yes, try it   Not now',
      'Quick safety check: is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder',
      'Do you trust the contents of this directory?\n› 1. Yes, continue',
      'Trust this folder? Codex can read, edit, and run files here\n› 1. Trust and continue',
      'Opening will not change saved trust.\n› 1. Open restricted',
      'Choose the text style that looks best with your terminal',
      'Detected a custom API key\nDo you want to use this API key?',
      '❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is',
    ].map(paneBlockingPrompt);

    // Assert
    should(actual).deepEqual([
      'Switch your default effort level?',
      'Try the new fullscreen renderer?',
      'Do you trust this folder?',
      'Do you trust this folder?',
      'Do you trust this folder?',
      'Open this untrusted folder restricted?',
      'Choose a text style (first-run setup)',
      'Use the custom API key it detected?',
      'Resume from a summary, or the full session?',
    ]);
  });

  it('should name nothing for an idle prompt, a working turn or a permission prompt', () => {
    should(paneBlockingPrompt('  ? for shortcuts\n│ > ')).be.undefined();
    should(paneBlockingPrompt('✽ Pontificating… (3s · esc to interrupt)')).be.undefined();
    should(paneBlockingPrompt('Do you want to proceed?\n❯ 1. Yes\n  2. No')).be.undefined();
  });

  it('should ignore a dialog that has scrolled out of the bottom of the frame', () => {
    should(paneBlockingPrompt([AUTO_NUDGE, ...Array.from({ length: 30 }, () => 'output')].join('\n'))).be.undefined();
  });

  it('should never read the auto-mode dialog as a ready prompt, though its cursor row looks like one', () => {
    // The `❯ Yes, set auto mode…` row matches the prompt shape, and the daemon used to type into it.
    should(promptIsReady(AUTO_NUDGE)).be.false();
    should(promptIsReady(AUTO_NUDGE, 4, 3)).be.false();
  });
});

describe('pane readiness under a permission prompt', () => {
  const FIXTURES = join(import.meta.dir, '../../fixtures/permission-prompts');

  it('should never call a pane ready while it shows a permission prompt, wherever tmux puts the cursor', () => {
    for (const name of readdirSync(FIXTURES)) {
      const frame = readFileSync(join(FIXTURES, name), 'utf8');
      const rows = frame.split('\n').length;
      should([promptIsReady(frame), promptIsReady(frame, rows - 1, 0), promptIsReady(frame, 0, 0)]).deepEqual(
        [false, false, false],
        name,
      );
    }
  });

  it('should still call a pane ready when a numbered question in the agent’s own words sits above its composer', () => {
    // The agent asked in prose and is idle: this is the person's turn, not a permission prompt.
    const frame = '● Would you like to proceed?\n  1. Ship it\n  2. Hold off\n\n────────\n❯ \n────────';
    should(promptIsReady(frame, 5, 2)).be.true();
  });
});

describe('pane readiness under a harness dialog', () => {
  const FIXTURES = join(import.meta.dir, '../../fixtures/harness-dialogs');

  it('should never call a pane ready while it shows a harness dialog, wherever tmux puts the cursor', () => {
    // Arrange — Codex’s `› 1. Review hooks` row is shaped like a composer line.
    for (const name of readdirSync(FIXTURES)) {
      const frame = readFileSync(join(FIXTURES, name), 'utf8');
      const rows = frame.split('\n').length;

      // Act
      const actual = [promptIsReady(frame), promptIsReady(frame, rows - 1, 0), promptIsReady(frame, 0, 0)];

      // Assert
      should(actual).deepEqual([false, false, false], name);
    }
  });

  it('should name the hooks review as not ready, with the cursor on the first row and on another', () => {
    // Act
    const actual = ['codex-0.156.1-hooks-review', 'codex-0.156.1-hooks-review-moved', 'codex-0.145.0-hooks-review'].map(
      name => promptIsReady(readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')),
    );

    // Assert
    should(actual).deepEqual([false, false, false]);
  });

  it('should still call an idle Codex composer ready', () => {
    // Arrange
    const frame = ['• Done.', '', '› Ask Codex to do anything', '', '  gpt-5.1-codex · 98% context left'].join('\n');

    // Act
    const actual = promptIsReady(frame, 2, 2);

    // Assert
    should(actual).be.true();
  });
});

describe('pane readiness under the feedback-draft panel', () => {
  // A REAL Claude Code 2.1.281 frame (80 columns), captured from a session the daemon held at "working"
  // for three hours: the turn is done (`done 12:09 AM · 5 shells still running`), the panel above the
  // composer truncates its title with `…`, and the composer holds a dim ghost suggestion.
  const FIXTURES = join(import.meta.dir, '../../fixtures/composer');
  const NAME = 'claude-2.1.281-feedback-draft-idle';
  const frame = readFileSync(join(FIXTURES, `${NAME}.txt`), 'utf8');
  const [cursorX, cursorY] = readFileSync(join(FIXTURES, `${NAME}.cursor`), 'utf8')
    .trim()
    .split('|')
    .map(Number);

  it('should read the finished turn as idle and ready, not as a spinner', () => {
    // Act
    const actual = {
      working: paneShowsActiveWork(frame),
      work: paneActiveWork(frame),
      ready: promptIsReady(frame, cursorY, cursorX),
    };

    // Assert
    should(actual).deepEqual({ working: false, work: undefined, ready: true });
  });

  it('should still read a running turn drawn over the same panel as busy', () => {
    // Arrange — the same frame mid-turn: the done line is the live spinner and the footer the interrupt hint.
    const busy = frame
      .replace(/^✻ Crunched for .*$/mu, '✻ Crunching… (12s · ↓ 1.4k tokens)')
      .replace('bypass permissions on ·', 'bypass permissions on · esc to interrupt ·');
    const bare = frame.replace(/^✻ Crunched for .*$/mu, '✽ Tomfoolering…');

    // Act
    const actual = { status: paneActiveWork(busy), spinner: paneActiveWork(bare) };

    // Assert
    should(actual).deepEqual({ status: 'status', spinner: 'spinner' });
  });

  it('should read a spinner only at the left edge, never inside a box', () => {
    // Act
    const actual = {
      boxedPhrase: paneShowsActiveWork('│ ✻ Bug report drafted: a title long enough to clip… │'),
      boxedMark: paneShowsActiveWork('│ ⏺ Searching… │'),
      indentedPhrase: paneShowsActiveWork('  ✶ Vibing…'),
      laterLinePhrase: paneShowsActiveWork('some output\n✢ Effecting…'),
    };

    // Assert
    should(actual).deepEqual({ boxedPhrase: false, boxedMark: false, indentedPhrase: true, laterLinePhrase: true });
  });
});
