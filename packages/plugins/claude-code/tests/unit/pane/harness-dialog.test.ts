import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { type HarnessDialog, type HarnessDialogOption, HarnessDialogSchema } from '../../../contract/index.ts';
import { dialogCursorMoves, paneBlockingDialog, parseHarnessDialog } from '../../../daemon/lib/pane/harness-dialog.ts';

/**
 * The harness's own dialog a pane is parked on, read off real captured Claude Code frames
 * (2.1.220 and 2.1.281); the synthetic frames below reach the branches no fixture happens to take.
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

const EXPECTED: Readonly<Record<string, Shape>> = {
  'claude-2.1.220-mcp-servers': {
    harness: 'claude-code',
    kind: 'mcp-servers',
    title: 'New MCP server found in this project: docs',
    body: MCP_BODY,
    options: MCP_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-mcp-servers': {
    harness: 'claude-code',
    kind: 'mcp-servers',
    title: 'New MCP server found in this project: docs',
    body: MCP_BODY,
    options: MCP_OPTIONS,
    escape: 'cancel',
    selected: 3,
  },
  'claude-2.1.220-settings-error': {
    harness: 'claude-code',
    kind: 'settings-error',
    title: 'Settings Error',
    body: SETTINGS_BODY,
    options: SETTINGS_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-settings-error': {
    harness: 'claude-code',
    kind: 'settings-error',
    title: 'Settings Error',
    body: SETTINGS_BODY,
    options: SETTINGS_OPTIONS,
    escape: 'cancel',
    selected: 1,
  },
  'claude-2.1.281-spend-limit': {
    harness: 'claude-code',
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
};

const parsed = (name: string): HarnessDialog => parseHarnessDialog(fixture(name)) as HarnessDialog;
const withoutId = ({ id: _id, ...rest }: HarnessDialog): Shape => rest;

describe('parseHarnessDialog — real captured panes', () => {
  it('has an expectation for every fixture, and no fixture is left unread', () => {
    const onDisk = readdirSync(DIALOGS)
      .map(file => file.replace(/\.txt$/u, ''))
      .sort();
    should(Object.keys(EXPECTED).sort()).deepEqual(onDisk);
  });

  for (const name of Object.keys(EXPECTED)) {
    it(`reads ${name} exactly`, () => {
      const actual = parsed(name);
      should(withoutId(actual)).deepEqual(EXPECTED[name] as Shape);
      should(HarnessDialogSchema.safeParse(actual).success).be.true();
    });
  }

  it('reads an unchanged fixture as the same dialog, run after run', () => {
    const [first, second] = [parsed('claude-2.1.220-settings-error'), parsed('claude-2.1.220-settings-error')];
    should(first).deepEqual(second);
    should(first.id).match(/^[0-9a-f]{16}$/u);
  });

  it('gives another id to another dialog', () => {
    const ids = ['claude-2.1.220-mcp-servers', 'claude-2.1.220-settings-error', 'claude-2.1.281-spend-limit'].map(
      name => parsed(name).id,
    );
    should(new Set(ids).size).equal(ids.length);
  });

  it('reads the same dialog across harness versions when only the cursor differs', () => {
    const [old, current] = [parsed('claude-2.1.220-mcp-servers'), parsed('claude-2.1.281-mcp-servers')];
    // 2.1.281 draws no digits and parks on row 3; what a person decides on is unchanged.
    should({ same: old.id === current.id, old: old.selected, current: current.selected }).deepEqual({
      same: true,
      old: 1,
      current: 3,
    });
  });

  it('reads a CRLF frame the same as an LF one', () => {
    const actual = parseHarnessDialog(fixture('claude-2.1.281-settings-error').replaceAll('\n', '\r\n'));
    should(actual).deepEqual(parsed('claude-2.1.281-settings-error'));
  });
});

describe('parseHarnessDialog — what is not a dialog', () => {
  it('reads no dialog off any tool-permission prompt, which has its own path', () => {
    const actual = Object.fromEntries(
      readdirSync(PERMISSIONS).map(file => [file, parseHarnessDialog(readFileSync(join(PERMISSIONS, file), 'utf8'))]),
    );
    should(Object.values(actual).filter(dialog => dialog !== undefined)).deepEqual([]);
    should(Object.keys(actual).length).be.above(10);
  });

  it('reads no dialog off an idle Claude frame or an empty one', () => {
    const claude = ['● Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
    should([parseHarnessDialog(claude), parseHarnessDialog('')]).deepEqual([undefined, undefined]);
  });

  it('reads no dialog when the key-hint footer is not the last line', () => {
    const frame = [RULE, '  Pick one', '', '❯ 1. A', '  2. B', '', '  Enter to confirm · Esc to cancel', 'more'].join(
      '\n',
    );
    should(parseHarnessDialog(frame)).be.undefined();
  });

  it('reads no dialog from a list with no cursor on any row', () => {
    const frame = [RULE, '  Pick one', '', '  1. A', '  2. B', '', '  Enter to confirm · Esc to cancel'].join('\n');
    should(parseHarnessDialog(frame)).be.undefined();
  });
});

describe('parseHarnessDialog — shapes no fixture draws', () => {
  it('reads a Claude dialog by its ❯ cursor and its full-width rule', () => {
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
    should(withoutId(parseHarnessDialog(frame) as HarnessDialog)).deepEqual({
      harness: 'claude-code',
      kind: 'other',
      title: 'Pick a flavour',
      body: 'Only one is mild.',
      options: [opt(1, 'Vanilla'), opt(2, 'Chocolate')],
      escape: 'cancel',
      selected: 1,
    });
  });

  it('joins the description lines under a numbered row into that row’s one detail', () => {
    const frame = [
      RULE,
      '  Pick a plan',
      '',
      '❯ 1. Pay as you go',
      '     Pay for what you use',
      '     and nothing more',
      '  2. Subscribe',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const dialog = parseHarnessDialog(frame) as HarnessDialog;
    should(dialog.options.map(option => [option.label, option.detail])).deepEqual([
      ['Pay as you go', 'Pay for what you use and nothing more'],
      ['Subscribe', undefined],
    ]);
  });

  it('with no rule over it, takes the header up to two blank lines in a row, keeping a single blank inside it', () => {
    const frame = [
      '  earlier agent output that is not part of the dialog',
      '',
      '',
      '  Pick a flavour',
      '',
      '  Only one is mild.',
      '',
      '❯ 1. Vanilla',
      '  2. Chocolate',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const dialog = parseHarnessDialog(frame) as HarnessDialog;
    should([dialog.title, dialog.body]).deepEqual(['Pick a flavour', 'Only one is mild.']);
  });

  it('with no rule over it, stops the header at the edge of a box', () => {
    const frame = [
      '╭──────────────╮',
      '│ some tool    │',
      '  Pick a flavour',
      '  Only one is mild.',
      '❯ 1. Vanilla',
      '  2. Chocolate',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const dialog = parseHarnessDialog(frame) as HarnessDialog;
    should([dialog.title, dialog.body]).deepEqual(['Pick a flavour', 'Only one is mild.']);
  });

  it('clips a long title to its limit, ending in an ellipsis', () => {
    const frame = [RULE, `  ${'T'.repeat(400)}`, '', '❯ 1. A', '  2. B', '', '  Enter to confirm · Esc to cancel'].join(
      '\n',
    );
    const dialog = parseHarnessDialog(frame) as HarnessDialog;
    should(dialog.title).equal(`${'T'.repeat(299)}…`);
    should(HarnessDialogSchema.safeParse(dialog).success).be.true();
  });
});

describe('parseHarnessDialog — what choosing a row grants', () => {
  const grants = (frame: string): boolean[] =>
    (parseHarnessDialog(frame) as HarnessDialog).options.map(option => option.grantsTrust);

  it('marks the folder-trust dialog’s yes, and not its no', () => {
    const frame = [
      RULE,
      ' Accessing workspace:',
      '',
      ' /work/project',
      '',
      ' Quick safety check: Is this a project you created or one you trust?',
      '',
      ' ❯ 1. Yes, I trust this folder',
      '   2. No, exit',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    const actual = parseHarnessDialog(frame) as HarnessDialog;
    should(actual.kind).equal('directory-trust');
    should(grants(frame)).deepEqual([true, false]);
  });

  it('marks only the MCP choices that use the server', () => {
    should(parsed('claude-2.1.220-mcp-servers').options.map(option => option.grantsTrust)).deepEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('dialogCursorMoves', () => {
  const dialog = parsed('claude-2.1.220-settings-error');

  it('moves down by the distance to a row below the cursor', () => {
    should(dialogCursorMoves(dialog, 3)).eql(['Down', 'Down']);
  });

  it('moves up by the distance to a row above the cursor', () => {
    should(dialogCursorMoves({ ...dialog, selected: 3 }, 1)).eql(['Up', 'Up']);
  });

  it('moves nowhere when the cursor is already on the row', () => {
    should(dialogCursorMoves(dialog, 1)).eql([]);
  });

  it('answers nothing for a row the dialog does not list', () => {
    should(dialogCursorMoves(dialog, 4)).be.undefined();
  });

  it('moves with the closed form keys alone, never a digit', () => {
    should(dialogCursorMoves(dialog, 2)).eql(['Down']);
  });
});

describe('paneBlockingDialog', () => {
  it('says nothing when the pane shows no dialog', () => {
    should(paneBlockingDialog('just output')).be.undefined();
  });

  it('names the dialog by its title', () => {
    should(paneBlockingDialog(fixture('claude-2.1.220-settings-error'))).equal(
      `Harness dialog — ${parsed('claude-2.1.220-settings-error').title}`,
    );
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

describe('parseHarnessDialog — one cursor row or no dialog to answer', () => {
  it('reads no dialog when two rows show a cursor', () => {
    const frame = fixture('claude-2.1.220-settings-error');
    const both = frame.replace(/^(\s*)\s\s(?=2\.)/mu, '$1❯ ');

    should(both).not.equal(frame);
    should(parseHarnessDialog(both)).be.undefined();
  });

  it('reads no dialog when no row shows a cursor', () => {
    const frame = fixture('claude-2.1.220-settings-error');

    should(parseHarnessDialog(frame.replace(/^(\s*)❯\s(?=1\.)/mu, '$1  '))).be.undefined();
  });
});
