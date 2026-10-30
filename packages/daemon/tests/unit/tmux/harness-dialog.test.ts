import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HarnessDialog, type HarnessDialogOption, HarnessDialogSchema } from '@ferretry/protocol';
import should from 'should';
import { DIALOG_KEYS, dialogCursorMoves, paneBlockingDialog, parseHarnessDialog } from '../../../src/lib/index.ts';

/**
 * The harness's own dialog a pane is parked on, read off real captured frames.
 *
 * The fixtures are frames of Codex 0.145.0 / 0.156.1 / 0.163.0 and Claude Code 2.1.220 / 2.1.281 as they were
 * drawn; the synthetic frames below reach the branches no fixture happens to take.
 */

const DIALOGS = join(import.meta.dir, '../../fixtures/harness-dialogs');
const PERMISSIONS = join(import.meta.dir, '../../fixtures/permission-prompts');
const fixture = (name: string): string => readFileSync(join(DIALOGS, `${name}.txt`), 'utf8');

const RULE = '─'.repeat(40);

const opt = (number: number, label: string, grantsTrust = false, detail?: string): HarnessDialogOption => ({
  number,
  label,
  ...(detail === undefined ? {} : { detail }),
  grantsTrust,
});

type Shape = Omit<HarnessDialog, 'id'>;

const HOOKS_BODY = (count: string): string => `${count}\nHooks can run outside the sandbox after you trust them.`;
const HOOKS_OPTIONS = [
  opt(1, 'Review hooks'),
  opt(2, 'Trust all and continue', true),
  opt(3, "Continue without trusting (hooks won't run)"),
];
const SIGN_IN_OPTIONS = [
  opt(1, 'Sign in with ChatGPT', false, 'Usage included with Plus, Pro, Business, and Enterprise plans'),
  opt(2, 'Sign in with Device Code', false, 'Sign in from another device with a one-time code'),
  opt(3, 'Provide your own API key', false, 'Pay for what you use'),
];
const SIGN_IN_TITLE = "Welcome to Codex, OpenAI's command-line coding agent";
const SIGN_IN_BODY =
  'Sign in with ChatGPT to use Codex as part of your paid plan\nor connect an API key for usage-based billing';
const UPDATE_OPTIONS = [
  opt(1, 'Update now (runs `npm install -g @openai/codex`)'),
  opt(2, 'Skip'),
  opt(3, 'Skip until next version'),
];
const RELEASE_NOTES = 'Release notes: https://github.com/openai/codex/releases/latest';
const MCP_BODY =
  'MCP servers may execute code or access system resources. All tool calls require approval. Learn\nmore in the MCP documentation.';
const MCP_OPTIONS = [
  opt(1, 'Use this MCP server', true),
  opt(2, 'Use this and all future MCP servers in this project', true),
  opt(3, 'Continue without using this MCP server'),
];
const SETTINGS_BODY = [
  '/home/dev/.claude/settings.json',
  '├ hooks: "hooks" must be an object mapping event names to matcher arrays; received string. This',
  'field was ignored.',
  '└ permissions.defaultMode: Invalid value. Expected one of: "acceptEdits", "auto",',
  '"bypassPermissions", "default", "dontAsk", "plan"',
  'Learn more: https://code.claude.com/docs/en/hooks',
  'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only),',
  '"bypassPermissions" (auto-accept all), or "default" (standard behavior)',
  'Learn more: https://code.claude.com/docs/en/iam#permission-modes',
  'Files with errors are skipped entirely, not just the invalid settings.',
].join('\n');
const SETTINGS_OPTIONS = [
  opt(1, 'Fix with Claude'),
  opt(2, 'Exit and fix manually'),
  opt(3, 'Continue without these settings'),
];

const FOLDER_TRUST_BODY = [
  'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings',
  'can run code automatically, even without a model request. Continue only if you trust these files. Your trust',
  'decision will be saved.',
].join('\n');
const FOLDER_TRUST_OPTIONS = [opt(1, 'Trust and continue', true), opt(2, 'Back to Agent Command Center')];

const EXPECTED: Readonly<Record<string, Shape>> = {
  'claude-2.1.220-mcp-servers': {
    harness: 'claude',
    kind: 'mcp-servers',
    title: 'New MCP server found in this project: docs',
    body: MCP_BODY,
    options: MCP_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-mcp-servers': {
    harness: 'claude',
    kind: 'mcp-servers',
    title: 'New MCP server found in this project: docs',
    body: MCP_BODY,
    options: MCP_OPTIONS,
    escape: 'cancel',
    selected: 3,
  },
  'claude-2.1.220-settings-error': {
    harness: 'claude',
    kind: 'settings-error',
    title: 'Settings Error',
    body: SETTINGS_BODY,
    options: SETTINGS_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-settings-error': {
    harness: 'claude',
    kind: 'settings-error',
    title: 'Settings Error',
    body: SETTINGS_BODY,
    options: SETTINGS_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-spend-limit': {
    harness: 'claude',
    kind: 'usage-limit',
    title: 'What do you want to do?',
    body: "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit",
    options: [
      opt(1, 'Stop and wait for limit to reset'),
      opt(2, 'Wait here, then continue automatically at Nov 1, 12am'),
      opt(3, 'Ask your admin for more usage'),
    ],
    escape: 'cancel',
    selected: 1,
  },
  'codex-0.145.0-hooks-review': {
    harness: 'codex',
    kind: 'hooks-review',
    title: 'Hooks need review',
    body: HOOKS_BODY('1 hook is new or changed.'),
    options: HOOKS_OPTIONS,
    escape: 'go back',
    selected: 1,
  },
  'codex-0.145.0-sign-in': {
    harness: 'codex',
    kind: 'sign-in',
    title: SIGN_IN_TITLE,
    body: SIGN_IN_BODY,
    options: SIGN_IN_OPTIONS,
    selected: 1,
  },
  'codex-0.145.0-update': {
    harness: 'codex',
    kind: 'update',
    title: '✨\u200aUpdate available! 0.145.0 -> 0.999.0',
    body: RELEASE_NOTES,
    options: UPDATE_OPTIONS,
    selected: 1,
  },
  'codex-0.156.1-hooks-list': {
    harness: 'codex',
    kind: 'hooks-list',
    title: 'Hooks',
    body: '⚠ 2 hooks need review before they can run.',
    options: [],
    escape: 'close',
  },
  'codex-0.156.1-hooks-review': {
    harness: 'codex',
    kind: 'hooks-review',
    title: 'Hooks need review',
    body: HOOKS_BODY('1 hook is new or changed.'),
    options: HOOKS_OPTIONS,
    escape: 'skip',
    selected: 1,
  },
  'codex-0.156.1-hooks-review-moved': {
    harness: 'codex',
    kind: 'hooks-review',
    title: 'Hooks need review',
    body: HOOKS_BODY('1 hook is new or changed.'),
    options: HOOKS_OPTIONS,
    escape: 'skip',
    selected: 2,
  },
  'codex-0.156.1-hooks-review-two': {
    harness: 'codex',
    kind: 'hooks-review',
    title: 'Hooks need review',
    body: HOOKS_BODY('2 hooks are new or changed.'),
    options: HOOKS_OPTIONS,
    escape: 'skip',
    selected: 1,
  },
  'codex-0.156.1-sign-in': {
    harness: 'codex',
    kind: 'sign-in',
    title: SIGN_IN_TITLE,
    body: SIGN_IN_BODY,
    options: SIGN_IN_OPTIONS,
    selected: 1,
  },
  'codex-0.156.1-update': {
    harness: 'codex',
    kind: 'update',
    title: 'Update available · 0.156.1 → 0.999.0',
    body: RELEASE_NOTES,
    options: UPDATE_OPTIONS,
    escape: 'skip',
    selected: 1,
  },
  // 0.164 asks it at startup when the configured model has a successor; Ferretry reads it as a generic dialog.
  'codex-0.164.0-model-migration': {
    harness: 'codex',
    kind: 'other',
    title: 'Meet GPT-6 Sol',
    body: [
      'Our latest Sol is more intelligent and more efficient so your usage limits go further. This',
      'model is a great daily driver for complex tasks, especially coding.',
    ].join('\n'),
    options: [opt(1, 'Try new model'), opt(2, 'Use existing model')],
    escape: 'confirm',
    selected: 1,
  },
  'codex-0.163.0-directory-trust': {
    harness: 'codex',
    kind: 'directory-trust',
    title: 'Folder access',
    body: `/home/dev/project\n${FOLDER_TRUST_BODY}`,
    options: FOLDER_TRUST_OPTIONS,
    escape: 'back',
    selected: 1,
  },
  'codex-0.163.0-directory-trust-subdirectory': {
    harness: 'codex',
    kind: 'directory-trust',
    title: 'Folder access',
    body: [
      '/home/dev/project/sub',
      'Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:',
      '/home/dev/project',
      FOLDER_TRUST_BODY,
    ].join('\n'),
    options: FOLDER_TRUST_OPTIONS,
    escape: 'back',
    selected: 1,
  },
  'codex-0.163.0-directory-restricted': {
    harness: 'codex',
    kind: 'directory-trust',
    title: 'Folder access',
    body: [
      '/home/dev/scratch',
      'Config, hooks, and exec policies from untrusted folders stay disabled. Trusted project folders can still contribute',
      'settings. Skills still load, and tools follow your permission settings. Opening will not change saved trust.',
    ].join('\n'),
    // Opening restricted changes no saved trust, so neither row grants any.
    options: [opt(1, 'Open restricted'), opt(2, 'Back to Agent Command Center')],
    escape: 'back',
    selected: 1,
  },
};

const parsed = (name: string): HarnessDialog => {
  const dialog = parseHarnessDialog(fixture(name));
  if (dialog === undefined) throw new Error(`${name} did not parse`);
  return dialog;
};

const withoutId = ({ id: _id, ...rest }: HarnessDialog): Shape => rest;

/** A Codex-shaped dialog drawn by hand: a title, a body, then the rows with the cursor on `cursor`. */
const codexFrame = (
  title: string,
  rows: readonly string[],
  cursor = 0,
  footer = 'enter confirm · esc skip',
  body: readonly string[] = [],
): string =>
  [
    '',
    `  ${title}`,
    ...body.map(line => `  ${line}`),
    '',
    ...rows.map((row, index) => `${index === cursor ? '›' : ' '} ${index + 1}. ${row}`),
    '',
    `  ${footer}`,
  ].join('\n');

describe('parseHarnessDialog — real captured panes', () => {
  it('has an expectation for every fixture, and no fixture is left unread', () => {
    // Arrange
    const onDisk = readdirSync(DIALOGS)
      .map(file => file.replace(/\.txt$/u, ''))
      .sort();

    // Act
    const actual = Object.keys(EXPECTED).sort();

    // Assert
    should(actual).deepEqual(onDisk);
  });

  for (const name of Object.keys(EXPECTED)) {
    it(`reads ${name} exactly`, () => {
      // Act
      const actual = parsed(name);

      // Assert
      should(withoutId(actual)).deepEqual(EXPECTED[name] as Shape);
      should(HarnessDialogSchema.safeParse(actual).success).be.true();
    });
  }

  it('reads an unchanged fixture as the same dialog, run after run', () => {
    // Act
    const [first, second] = [parsed('codex-0.156.1-hooks-review'), parsed('codex-0.156.1-hooks-review')];

    // Assert
    should(first).deepEqual(second);
    should(first.id).match(/^[0-9a-f]{16}$/u);
  });

  it('keeps the id when only the cursor moves, and follows the cursor in `selected`', () => {
    // Act
    const [still, moved] = [parsed('codex-0.156.1-hooks-review'), parsed('codex-0.156.1-hooks-review-moved')];

    // Assert
    should({ same: moved.id === still.id, still: still.selected, moved: moved.selected }).deepEqual({
      same: true,
      still: 1,
      moved: 2,
    });
  });

  it('gives another id to another dialog', () => {
    // Act
    const ids = [
      'codex-0.156.1-hooks-review',
      'codex-0.156.1-hooks-review-two',
      'codex-0.145.0-hooks-review',
      'codex-0.156.1-update',
      'codex-0.156.1-sign-in',
      'codex-0.156.1-hooks-list',
      'claude-2.1.220-mcp-servers',
      'claude-2.1.220-settings-error',
    ].map(name => parsed(name).id);

    // Assert
    should(new Set(ids).size).equal(ids.length);
  });

  it('reads the same dialog across harness versions when only the cursor differs', () => {
    // Act
    const [old, current] = [parsed('claude-2.1.220-mcp-servers'), parsed('claude-2.1.281-mcp-servers')];

    // Assert — 2.1.281 draws no digits and parks on row 3; what a person decides on is unchanged.
    should({ same: old.id === current.id, old: old.selected, current: current.selected }).deepEqual({
      same: true,
      old: 1,
      current: 3,
    });
  });

  it('names the footer’s word for Esc per version, and none where the footer has no Esc', () => {
    // Act
    const actual = [
      'codex-0.145.0-hooks-review',
      'codex-0.156.1-hooks-review',
      'codex-0.156.1-update',
      'codex-0.145.0-update',
      'claude-2.1.281-settings-error',
      'codex-0.156.1-hooks-list',
    ].map(name => parsed(name).escape);

    // Assert
    should(actual).deepEqual(['go back', 'skip', 'skip', undefined, 'cancel', 'close']);
  });

  it('reads a CRLF frame the same as an LF one', () => {
    // Act
    const actual = parseHarnessDialog(fixture('codex-0.156.1-update').replaceAll('\n', '\r\n'));

    // Assert
    should(actual).deepEqual(parsed('codex-0.156.1-update'));
  });
});

describe('parseHarnessDialog — what is not a dialog', () => {
  it('reads no dialog off any tool-permission prompt, which has its own path', () => {
    // Act
    const actual = Object.fromEntries(
      readdirSync(PERMISSIONS).map(file => [file, parseHarnessDialog(readFileSync(join(PERMISSIONS, file), 'utf8'))]),
    );

    // Assert
    should(Object.values(actual).filter(dialog => dialog !== undefined)).deepEqual([]);
    should(Object.keys(actual).length).be.above(10);
  });

  it('reads no dialog off an idle Claude or Codex frame', () => {
    // Arrange
    const claude = ['● Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
    const codex = ['• Done.', '', '› Ask Codex to do anything', '', '  gpt-5.1-codex · 98% context left'].join('\n');

    // Act
    const actual = [parseHarnessDialog(claude), parseHarnessDialog(codex), parseHarnessDialog('')];

    // Assert
    should(actual).deepEqual([undefined, undefined, undefined]);
  });

  it('reads no dialog off agent output with a numbered list and a composer below it', () => {
    // Arrange
    const frame = [
      'Here are the options I found:',
      '',
      '› 1. use the cache',
      '  2. skip the cache',
      '',
      '› ',
      '  enter send · esc interrupt',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert — the rows are the agent's prose; the composer below makes the footer not a dialog's.
    should(actual).be.undefined();
  });

  it('reads no dialog when the key-hint footer is not the last line', () => {
    // Arrange
    const frame = `${codexFrame('Hooks need review', ['Review hooks', 'Trust all and continue'])}\n\n› `;

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert
    should(actual).be.undefined();
  });

  it('reads no dialog from a footer that names neither Enter nor Esc', () => {
    // Act
    const actual = parseHarnessDialog(
      codexFrame('Hooks need review', ['Review hooks', 'Trust all'], 0, 'tab to continue'),
    );

    // Assert
    should(actual).be.undefined();
  });

  it('reads no dialog from a list with no cursor on any row', () => {
    // Arrange
    const frame = ['  Pick one', '', '  1. First', '  2. Second', '', '  enter confirm · esc skip'].join('\n');

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert
    should(actual).be.undefined();
  });

  it('reads no dialog from more than nine rows', () => {
    // Arrange
    const rows = Array.from({ length: 10 }, (_, index) => `Choice ${index}`);
    const frame = ['  Pick one', '', ...rows.map((row, index) => `${index === 0 ? '›' : ' '} ${row}`)];

    // Act
    const actual = parseHarnessDialog([...frame, '', '  enter confirm · esc skip'].join('\n'));

    // Assert — unnumbered rows, so the cap is the row count itself.
    should(actual).be.undefined();
  });

  it('reads no dialog from a frame with no header above its rows', () => {
    // Arrange
    const frame = ['› 1. Review hooks', '  2. Trust all and continue', '', '  enter confirm · esc skip'].join('\n');

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert
    should(actual).be.undefined();
  });

  it('reads no dialog when something other than a row or its description sits between the cursor and the footer', () => {
    // Arrange
    const frame = ['  Pick one', '', '› 1. First', 'unrelated output at the margin', '', '  enter confirm'].join('\n');

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert
    should(actual).be.undefined();
  });

  it('reads the hook list only under its own title and warning', () => {
    // Arrange
    const noTitle = ['  Lifecycle hooks from config', '', '  t trust all · enter review · esc close'].join('\n');
    const unrelated = ['  Settings', '  Lifecycle hooks from config and enabled plugins.', '', '  esc close'].join(
      '\n',
    );

    // Act
    const actual = [parseHarnessDialog(noTitle), parseHarnessDialog(unrelated)];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });
});

describe('parseHarnessDialog — shapes no fixture draws', () => {
  it('reads a hook list with no warning line as a dialog with no body', () => {
    // Arrange
    const frame = [
      '  Hooks',
      '  Lifecycle hooks from config and enabled plugins.',
      '',
      '  Event          Installed',
      '',
      '  t trust all · enter review · esc close',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame);

    // Assert
    should(actual).containEql({ kind: 'hooks-list', title: 'Hooks', options: [], escape: 'close' });
    should(actual).not.have.property('body');
  });

  it('reads an unnamed screen of the same shape as `other`, titled by its first header line', () => {
    // Arrange
    const frame = codexFrame('Pick a flavour', ['Vanilla', 'Chocolate'], 1, 'enter confirm · esc to go back', [
      'Something to know first.',
    ]);

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(withoutId(actual)).deepEqual({
      harness: 'codex',
      kind: 'other',
      title: 'Pick a flavour',
      body: 'Something to know first.',
      options: [opt(1, 'Vanilla'), opt(2, 'Chocolate')],
      escape: 'go back',
      selected: 2,
    });
  });

  it('reads an unnamed dialog with no body and no Esc, taking `>` as a Codex cursor', () => {
    // Arrange
    const frame = ['  Pick a flavour', '', '> 1. Vanilla', '  2. Chocolate', '', '  Press enter to continue'].join(
      '\n',
    );

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(actual.harness).equal('codex');
    should(actual).not.have.property('body');
    should(actual).not.have.property('escape');
  });

  it('reads a Claude dialog by its ❯ cursor and its full-width rule', () => {
    // Arrange
    const frame = [
      'earlier agent output that is not part of the dialog',
      RULE,
      '  Pick a flavour',
      '',
      '  Only one is mild.',
      '',
      '❯ 1. Vanilla',
      '  2. Chocolate',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(withoutId(actual)).deepEqual({
      harness: 'claude',
      kind: 'other',
      title: 'Pick a flavour',
      body: 'Only one is mild.',
      options: [opt(1, 'Vanilla'), opt(2, 'Chocolate')],
      escape: 'cancel',
      selected: 1,
    });
  });

  it('stops a ruleless header at a box edge', () => {
    // Arrange
    const frame = [
      '╭──────────────╮',
      '│ banner above │',
      '  Pick a flavour',
      '',
      '› 1. Vanilla',
      '  2. Chocolate',
      '',
      '  enter confirm',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(actual.title).equal('Pick a flavour');
    should(actual).not.have.property('body');
  });

  it('stops a ruleless header at two blank lines in a row', () => {
    // Arrange
    const frame = [
      '  stale output above',
      '',
      '',
      '  Pick a flavour',
      '  One line of body.',
      '',
      '› 1. Vanilla',
      '  2. Chocolate',
      '',
      '  enter confirm',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should({ title: actual.title, body: actual.body }).deepEqual({
      title: 'Pick a flavour',
      body: 'One line of body.',
    });
  });

  it('keeps a header’s single blank lines and caps it at sixteen lines', () => {
    // Arrange
    const header = Array.from({ length: 20 }, (_, index) => `  line ${index + 1}`);
    const frame = [...header, '', '› 1. Vanilla', '  2. Chocolate', '', '  enter confirm'].join('\n');

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert — the nearest sixteen lines to the rows survive; the title is the first of those.
    should(actual.title).equal('line 5');
    should((actual.body as string).split('\n').at(-1)).equal('line 20');
  });

  it('ignores a rule too far above the rows to be the dialog’s', () => {
    // Arrange
    const filler = Array.from({ length: 32 }, () => '  filler');
    const frame = [
      RULE,
      ...filler,
      '',
      '',
      '  Pick a flavour',
      '› 1. Vanilla',
      '  2. Chocolate',
      '',
      '  enter confirm',
    ];

    // Act
    const actual = parseHarnessDialog(frame.join('\n')) as HarnessDialog;

    // Assert — the rule is out of reach, so the header ends at the two blank lines above the title.
    should(actual.title).equal('Pick a flavour');
  });

  it('reads blank-separated rows with descriptions under them', () => {
    // Act
    const actual = parsed('codex-0.156.1-sign-in');

    // Assert
    should(actual.options.map(option => option.detail !== undefined)).deepEqual([true, true, true]);
  });

  it('joins a row’s several description lines', () => {
    // Arrange
    const frame = [
      '  Pick a plan',
      '',
      '> 1. Basic',
      '     Cheap.',
      '     Slow.',
      '  2. Pro',
      '',
      '  Press enter to continue',
    ].join('\n');

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(actual.options[0]?.detail).equal('Cheap. Slow.');
  });

  it('reads unnumbered rows by the column the cursor row starts its label at', () => {
    // Act
    const actual = parsed('claude-2.1.281-mcp-servers');

    // Assert
    should(actual.options.map(option => option.number)).deepEqual([1, 2, 3]);
    should(actual.selected).equal(3);
  });

  it('clips every long value to its limit, ending in an ellipsis', () => {
    // Arrange
    const long = (length: number): string => 'x'.repeat(length);
    const frame = codexFrame(long(400), [long(400), 'Short'], 0, 'enter confirm', [long(1500)]);

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should({
      title: actual.title.length,
      body: actual.body?.length,
      label: actual.options[0]?.label.length,
    }).deepEqual({ title: 300, body: 1200, label: 300 });
    should([actual.title.endsWith('…'), actual.body?.endsWith('…'), actual.options[0]?.label.endsWith('…')]).deepEqual([
      true,
      true,
      true,
    ]);
    should(HarnessDialogSchema.safeParse(actual).success).be.true();
  });

  it('clips a long description to its limit', () => {
    // Arrange
    const frame = [
      '  Pick a plan',
      '',
      '> 1. Basic',
      `     ${'y'.repeat(400)}`,
      '  2. Pro',
      '',
      '  Press enter to continue',
    ];

    // Act
    const actual = parseHarnessDialog(frame.join('\n')) as HarnessDialog;

    // Assert
    should(actual.options[0]?.detail?.length).equal(300);
  });
});

describe('parseHarnessDialog — what choosing a row grants', () => {
  const grants = (frame: string): boolean[] =>
    (parseHarnessDialog(frame) as HarnessDialog).options.map(option => option.grantsTrust);

  it('marks the directory-trust dialog’s yes, and not its no', () => {
    // Arrange
    const frame = codexFrame(
      'Do you trust the contents of this directory?',
      ['Yes, continue', 'No, quit'],
      0,
      'Press enter to continue',
    );

    // Act
    const actual = parseHarnessDialog(frame) as HarnessDialog;

    // Assert
    should(actual.kind).equal('directory-trust');
    should(grants(frame)).deepEqual([true, false]);
  });

  it('marks a generic row that says it trusts, unless it says it does not', () => {
    // Arrange
    const frame = codexFrame('Something new', [
      'Trust this folder',
      'Don’t trust this folder',
      "Don't trust it",
      'Trust without the sandbox',
      'No, trust nothing',
      'Do not trust',
      'Continue',
    ]);

    // Act
    const actual = grants(frame);

    // Assert
    should(actual).deepEqual([true, false, false, false, false, false, false]);
  });

  it('marks only the MCP choices that use the server', () => {
    // Act
    const actual = parsed('claude-2.1.220-mcp-servers').options.map(option => option.grantsTrust);

    // Assert
    should(actual).deepEqual([true, true, false]);
  });
});

describe('dialogCursorMoves', () => {
  const hooks = (): HarnessDialog => parsed('codex-0.156.1-hooks-review');

  it('moves down by the distance to a row below the cursor', () => {
    // Act
    const actual = [dialogCursorMoves(hooks(), 2), dialogCursorMoves(hooks(), 3)];

    // Assert
    should(actual).deepEqual([DIALOG_KEYS.down, DIALOG_KEYS.down.repeat(2)]);
  });

  it('moves up by the distance to a row above the cursor', () => {
    // Act
    const actual = dialogCursorMoves(parsed('claude-2.1.281-mcp-servers'), 1);

    // Assert
    should(actual).equal(DIALOG_KEYS.up.repeat(2));
  });

  it('moves nowhere when the cursor is already on the row', () => {
    // Act
    const actual = dialogCursorMoves(hooks(), 1);

    // Assert
    should(actual).equal('');
  });

  it('answers nothing for a row the dialog does not list', () => {
    // Act
    const actual = [dialogCursorMoves(hooks(), 4), dialogCursorMoves(hooks(), 0)];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });

  it('answers nothing for a dialog with no cursor', () => {
    // Act
    const actual = dialogCursorMoves(parsed('codex-0.156.1-hooks-list'), 1);

    // Assert
    should(actual).be.undefined();
  });

  it('sends the bytes a terminal sends for each key', () => {
    // Assert
    should(DIALOG_KEYS).deepEqual({ up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b' });
  });
});

describe('paneBlockingDialog', () => {
  it('says nothing when the pane shows no dialog', () => {
    // Assert
    should(paneBlockingDialog('> ')).be.undefined();
  });

  it('names the dialog by its title', () => {
    // Act
    const actual = paneBlockingDialog(fixture('codex-0.156.1-hooks-review'));

    // Assert
    should(actual).equal('Harness dialog — Hooks need review');
  });

  it('clips the line at 200 characters', () => {
    // Arrange
    const frame = codexFrame('t'.repeat(290), ['Vanilla', 'Chocolate']);

    // Act
    const actual = paneBlockingDialog(frame) as string;

    // Assert
    should(actual.length).equal(200);
    should(actual.endsWith('…')).be.true();
  });
});

describe('the usage-limit dialog', () => {
  it('should read the live spend-limit frame as a usage-limit dialog carrying the notice', () => {
    // Act
    const dialog = parseHarnessDialog(fixture('claude-2.1.281-spend-limit'));

    // Assert
    should(dialog?.kind).equal('usage-limit');
    should(dialog?.title).equal('What do you want to do?');
    should(dialog?.body).startWith("You've hit your org's monthly spend limit");
    should(dialog?.body).containEql('admin for a higher limit');
    should(dialog?.options.map(option => option.label)).deepEqual([
      'Stop and wait for limit to reset',
      'Wait here, then continue automatically at Nov 1, 12am',
      'Ask your admin for more usage',
    ]);
    should(HarnessDialogSchema.safeParse(dialog).success).be.true();
  });

  it('should still read the dialog when the notice is not on screen', () => {
    // Arrange
    const frame = [
      '❯ /rate-limit-options',
      '',
      RULE,
      '  What do you want to do?',
      '',
      '  ❯ 1. Stop and wait for limit to reset',
      '    2. Ask your admin for more usage',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    // Act
    const dialog = parseHarnessDialog(frame);

    // Assert
    should(dialog?.kind).equal('usage-limit');
    should(dialog?.body).be.undefined();
  });

  it('should not call another dialog a usage limit just because the title is generic', () => {
    // Arrange
    const frame = [
      RULE,
      '  What do you want to do?',
      '',
      '  ❯ 1. Open the file',
      '    2. Close the file',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    // Act
    const dialog = parseHarnessDialog(frame);

    // Assert
    should(dialog?.kind).not.equal('usage-limit');
  });
});
