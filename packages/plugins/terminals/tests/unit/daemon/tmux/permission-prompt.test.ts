import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PermissionOptionKind, PermissionRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { paneBlockingPermission, parsePermissionPrompt, permissionAnswerKeys } from '../../../src/lib/index.ts';

/**
 * The permission prompt a harness is parked on, read off real captured panes.
 *
 * The fixtures are frames of Claude Code 2.1.220 / 2.1.281 and Codex 0.145.0 / 0.156.1 / 0.164.0 as they were
 * drawn; the synthetic frames below reach the branches no fixture happens to take.
 */

const FIXTURES = join(import.meta.dir, '../../fixtures/permission-prompts');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');

const RULE = '─'.repeat(40);

/** A Claude dialog: output above, a full-width rule, the title, its body, the question and the choices. */
const claudeDialog = (title: string, body: readonly string[], question = 'Do you want to proceed?'): string =>
  [
    'some agent output',
    RULE,
    ` ${title}`,
    ...body.map(line => `   ${line}`),
    '',
    ` ${question}`,
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n');

/** A Codex approval: the question, the details under it, then the hinted choice list. */
const codexApproval = (question: string, details: readonly string[]): string =>
  [
    '• Ran something',
    `  ${question}`,
    ...details.map(line => `  ${line}`),
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
  ].join('\n');

const opt = (number: number, label: string, kind: PermissionOptionKind) => ({ number, label, kind });

const YES = opt(1, 'Yes', 'allow');
const NO = opt(3, 'No', 'deny');
const CLAUDE_AUTO_SWITCH =
  'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session';

interface Expected {
  readonly harness: 'claude' | 'codex';
  readonly tool: string;
  readonly action: string;
  readonly what?: string;
  readonly detail?: string;
  readonly question: string;
  readonly options: readonly ReturnType<typeof opt>[];
}

const EXPECTED: Readonly<Record<string, Expected>> = {
  'claude-2.1.220-bash': {
    harness: 'claude',
    tool: 'Bash',
    action: 'run',
    what: 'curl -s https://example.com | head',
    detail: 'Fetch example',
    question: 'Do you want to proceed?',
    options: [YES, opt(2, 'Yes, and don’t ask again for: curl -s https://example.com', 'allow-always'), NO],
  },
  'claude-2.1.220-edit': {
    harness: 'claude',
    tool: 'Edit',
    action: 'edit',
    what: 'a.txt',
    question: 'Do you want to make this edit to a.txt?',
    options: [YES, opt(2, 'Yes, allow all edits during this session', 'allow-always'), NO],
  },
  'claude-2.1.220-mcp': {
    harness: 'claude',
    tool: 'MCP',
    action: 'use',
    what: 'deploy - release(version: "1.2.3")',
    detail: 'Ship a release',
    question: 'Do you want to proceed?',
    options: [
      YES,
      opt(2, "Yes, and don't ask again for deploy - release commands in /home/dev/project", 'allow-always'),
      NO,
    ],
  },
  'claude-2.1.220-plan': {
    harness: 'claude',
    tool: 'Plan',
    action: 'exit-plan',
    detail: 'Claude wants to exit plan mode',
    question: 'Exit plan mode?',
    options: [YES, opt(2, 'No', 'deny')],
  },
  'claude-2.1.220-read-outside': {
    harness: 'claude',
    tool: 'Read',
    action: 'read',
    what: '/etc/hostname',
    question: 'Do you want to proceed?',
    options: [YES, opt(2, 'Yes, allow reading from etc/ during this session', 'allow-always'), NO],
  },
  'claude-2.1.220-webfetch': {
    harness: 'claude',
    tool: 'WebFetch',
    action: 'fetch',
    what: 'https://example.com/docs',
    question: 'Do you want to allow Claude to fetch this content?',
    options: [
      YES,
      opt(2, "Yes, and don't ask again for example.com", 'allow-always'),
      opt(3, 'No, and tell Claude what to do differently', 'deny'),
    ],
  },
  'claude-2.1.220-write-outside': {
    harness: 'claude',
    tool: 'Write',
    action: 'create',
    what: '../../fy-perm-out.txt',
    question: 'Do you want to create fy-perm-out.txt?',
    options: [YES, opt(2, 'Yes, allow all edits in tmp/ during this session', 'allow-always'), NO],
  },
  'claude-2.1.220-write': {
    harness: 'claude',
    tool: 'Write',
    action: 'create',
    what: 'new.txt',
    question: 'Do you want to create new.txt?',
    options: [YES, opt(2, 'Yes, allow all edits during this session', 'allow-always'), NO],
  },
  'claude-2.1.281-bash': {
    harness: 'claude',
    tool: 'Bash',
    action: 'run',
    what: 'curl -s https://example.com | head',
    detail: 'Fetch example',
    question: 'Do you want to proceed?',
    options: [
      YES,
      opt(2, 'Yes, and don’t ask again for: curl -s https://example.com', 'allow-always'),
      opt(3, 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'allow-always'),
      opt(4, 'No', 'deny'),
    ],
  },
  'claude-2.1.281-edit': {
    harness: 'claude',
    tool: 'Edit',
    action: 'edit',
    what: 'a.txt',
    question: 'Do you want to make this edit to a.txt?',
    options: [YES, opt(2, CLAUDE_AUTO_SWITCH, 'allow-always'), NO],
  },
  'claude-2.1.281-mcp': {
    harness: 'claude',
    tool: 'MCP',
    action: 'use',
    what: 'deploy — Release Tool',
    detail: 'Ship a release',
    question: 'Do you want to proceed?',
    options: [
      YES,
      opt(2, "Yes, and don't ask again for deploy — Release commands in /home/dev/project", 'allow-always'),
      NO,
    ],
  },
  'claude-2.1.281-plan': {
    harness: 'claude',
    tool: 'Plan',
    action: 'exit-plan',
    detail: 'Claude wants to exit plan mode',
    question: 'Exit plan mode?',
    options: [
      opt(1, 'Yes, and switch to default (ask each time) for this session', 'allow-always'),
      opt(2, 'No', 'deny'),
    ],
  },
  'claude-2.1.281-read-outside': {
    harness: 'claude',
    tool: 'Read',
    action: 'read',
    what: '/etc/hostname',
    question: 'Do you want to proceed?',
    options: [YES, opt(2, 'Yes, allow reading from /etc during this session', 'allow-always'), NO],
  },
  'claude-2.1.281-webfetch': {
    harness: 'claude',
    tool: 'WebFetch',
    action: 'fetch',
    what: 'https://example.com/docs',
    question: 'Do you want to allow Claude to fetch this content?',
    options: [
      YES,
      opt(2, "Yes, and don't ask again for example.com", 'allow-always'),
      opt(3, 'No, and tell Claude what to do differently', 'deny'),
    ],
  },
  'claude-2.1.281-write-outside': {
    harness: 'claude',
    tool: 'Write',
    action: 'create',
    what: '../../fy-perm-out.txt',
    question: 'Do you want to create fy-perm-out.txt?',
    options: [
      YES,
      opt(2, `${CLAUDE_AUTO_SWITCH}; Yes, and always allow access to /tmp for this session`, 'allow-always'),
      NO,
    ],
  },
  'claude-2.1.281-write': {
    harness: 'claude',
    tool: 'Write',
    action: 'create',
    what: 'new.txt',
    question: 'Do you want to create new.txt?',
    options: [YES, opt(2, CLAUDE_AUTO_SWITCH, 'allow-always'), NO],
  },
  'codex-0.145.0-patch': {
    harness: 'codex',
    tool: 'Edit',
    action: 'edit',
    what: 'hello.txt',
    question: 'Would you like to make the following edits?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for these files", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
  'codex-0.145.0-shell': {
    harness: 'codex',
    tool: 'Shell',
    action: 'run',
    what: 'rm -rf build',
    detail: 'Clean the build output',
    question: 'Would you like to run the following command?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for commands that start with `rm -rf build`", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
  'codex-0.156.1-patch': {
    harness: 'codex',
    tool: 'Edit',
    action: 'edit',
    what: '/home/dev/project/hello.txt',
    question: 'Would you like to make the following edits?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for these files", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
  'codex-0.164.0-patch': {
    harness: 'codex',
    tool: 'Edit',
    action: 'edit',
    what: '/home/dev/project/hello.txt',
    question: 'Would you like to make the following edits?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for these files", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
  'codex-0.164.0-shell': {
    harness: 'codex',
    tool: 'Shell',
    action: 'run',
    what: 'rm -rf build',
    detail: 'Clean the build output',
    question: 'Would you like to run the following command?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for commands that start with `rm -rf build`", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
  'codex-0.156.1-shell': {
    harness: 'codex',
    tool: 'Shell',
    action: 'run',
    what: 'rm -rf build',
    detail: 'Clean the build output',
    question: 'Would you like to run the following command?',
    options: [
      opt(1, 'Yes, proceed', 'allow'),
      opt(2, "Yes, and don't ask again for commands that start with `rm -rf build`", 'allow-always'),
      opt(3, 'No, and tell Codex what to do differently', 'deny'),
    ],
  },
};

describe('parsePermissionPrompt — real captured panes', () => {
  it('has an expectation for every fixture, and no fixture is left unread', () => {
    // Arrange
    const onDisk = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.txt'))
      .map(name => name.replace(/\.txt$/u, ''))
      .sort();

    // Act
    const expected = Object.keys(EXPECTED).sort();

    // Assert
    should(expected).eql(onDisk);
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`reads ${name} exactly`, () => {
      // Arrange
      const pane = fixture(name);

      // Act
      const request = parsePermissionPrompt(pane);

      // Assert
      should(request).not.be.undefined();
      should(PermissionRequestSchema.safeParse(request).success).be.true();
      const { id, selected, ...rest } = request as NonNullable<typeof request>;
      should(id).match(/^[0-9a-f]{16}$/u);
      should(selected).equal(1);
      should(rest).eql(expected);
    });
  }

  it('reads an unchanged fixture as the same request, run after run', () => {
    // Arrange
    const pane = fixture('claude-2.1.281-bash');

    // Act
    const first = parsePermissionPrompt(pane);
    const second = parsePermissionPrompt(pane);

    // Assert
    should(first?.id).equal(second?.id);
  });
});

describe('parsePermissionPrompt — identity', () => {
  it('keeps the id when only the cursor moves, and follows the cursor in `selected`', () => {
    // Arrange
    const pane = fixture('claude-2.1.281-bash');
    const moved = pane
      .replace('❯ 1. Yes', '  1. Yes')
      .replace('  2. Yes, and don’t ask again', '❯ 2. Yes, and don’t ask again');

    // Act
    const before = parsePermissionPrompt(pane);
    const after = parsePermissionPrompt(moved);

    // Assert
    should(before?.selected).equal(1);
    should(after?.selected).equal(2);
    should(after?.id).equal(before?.id);
  });

  it('gives another id when the command changes', () => {
    // Arrange
    const pane = fixture('claude-2.1.281-bash');

    // Act
    const other = parsePermissionPrompt(pane.replaceAll('curl -s https://example.com | head', 'rm -rf /'));

    // Assert
    should(other?.what).equal('rm -rf /');
    should(other?.id).not.equal(parsePermissionPrompt(pane)?.id);
  });

  it('gives another id when the path changes', () => {
    // Arrange
    const pane = fixture('claude-2.1.281-write');

    // Act
    const other = parsePermissionPrompt(pane.replaceAll('new.txt', 'other.txt'));

    // Assert
    should(other?.what).equal('other.txt');
    should(other?.id).not.equal(parsePermissionPrompt(pane)?.id);
  });

  it('gives another id when the choices change', () => {
    // Arrange
    const older = fixture('claude-2.1.220-bash');
    const newer = fixture('claude-2.1.281-bash');

    // Act
    const [first, second] = [parsePermissionPrompt(older), parsePermissionPrompt(newer)];

    // Assert
    should(first?.what).equal(second?.what);
    should(first?.id).not.equal(second?.id);
  });
});

describe('parsePermissionPrompt — what is not a permission prompt', () => {
  it('ignores a numbered list in agent output that has no question above it', () => {
    // Arrange
    const pane = ['Here is the plan:', '1. Install', '2. Build', '3. Ship', '', '❯ '].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores a question with only one choice', () => {
    // Arrange
    const pane = ['Do you want to proceed?', ' ❯ 1. Yes'].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores a prompt whose choices scrolled above the bottom of the frame', () => {
    // Arrange
    const scrolled = [fixture('claude-2.1.281-bash').trimEnd(), ...Array.from({ length: 30 }, () => 'later output')];

    // Act / Assert
    should(parsePermissionPrompt(fixture('claude-2.1.281-bash'))).not.be.undefined();
    should(parsePermissionPrompt(scrolled.join('\n'))).be.undefined();
  });

  it('ignores a question that sits too far above its choices', () => {
    // Arrange
    const pane = [
      'Do you want to proceed?',
      ...Array.from({ length: 14 }, () => 'unrelated output'),
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores the API-key dialog, which has its own answer path', () => {
    // Arrange
    const pane = [
      ' Detected a custom API key in your environment',
      '',
      ' Do you want to use this API key?',
      ' ❯ 1. Yes',
      '   2. No (recommended)',
    ].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores the auto-mode nudge, whose rows carry no numbers', () => {
    // Arrange
    const pane = [
      ' Make auto mode your default permission mode?',
      '',
      '   Auto mode lets Claude handle permission prompts automatically.',
      '',
      '   ❯ Yes, set auto mode as my default permission mode',
      '     No, keep bypass permissions',
    ].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores choices that are not numbered 1..n', () => {
    // Arrange
    const startsAtTwo = ['Do you want to proceed?', ' ❯ 2. Yes', '   3. No'].join('\n');
    const skipsTwo = ['Do you want to proceed?', ' ❯ 1. Yes', '   3. No'].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(startsAtTwo)).be.undefined();
    should(parsePermissionPrompt(skipsTwo)).be.undefined();
  });

  it('ignores a numbered list in agent prose when a composer line sits below it', () => {
    // Arrange
    const claudeIdle = ['Would you like to proceed?', ' ❯ 1. Yes', '   2. No', '', '❯ ', '  ? for shortcuts'].join(
      '\n',
    );
    const codexIdle = ['Do you want to proceed?', '  1. Yes', '  2. No', '', '› Ask Codex to do anything'].join('\n');
    const boxedIdle = ['Do you want to proceed?', '  1. Yes', '  2. No', '│ > │'].join('\n');

    // Act / Assert
    should(parsePermissionPrompt(claudeIdle)).be.undefined();
    should(parsePermissionPrompt(codexIdle)).be.undefined();
    should(parsePermissionPrompt(boxedIdle)).be.undefined();
  });

  it('ignores a real dialog once an idle composer is drawn under it', () => {
    // Arrange
    const pane = `${fixture('claude-2.1.281-bash').trimEnd()}\n\n❯ `;

    // Act / Assert
    should(parsePermissionPrompt(fixture('claude-2.1.281-bash'))).not.be.undefined();
    should(parsePermissionPrompt(pane)).be.undefined();
  });

  it('ignores an empty pane', () => {
    // Act / Assert
    should(parsePermissionPrompt('')).be.undefined();
    should(parsePermissionPrompt('  \n\n')).be.undefined();
  });
});

describe('parsePermissionPrompt — shapes no fixture draws', () => {
  it('reads a ruleless Claude dialog from the unbroken block of rows above its question', () => {
    // Arrange
    const pane = [
      'earlier output',
      '',
      ' Read file',
      '  Read(/etc/hostname)',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request).containEql({ harness: 'claude', tool: 'Read', action: 'read', what: '/etc/hostname' });
  });

  it('looks no more than eight rows above the question for a ruleless dialog’s title', () => {
    // Arrange
    const pane = [
      ' Bash command',
      ...Array.from({ length: 10 }, (_, index) => `  row ${index}`),
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request?.tool).equal('row 2');
    should(request?.action).equal('other');
  });

  it('reads a ruleless dialog with a blank row above its question as a generic tool', () => {
    // Arrange
    const pane = [' Bash command', '  ls', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request).containEql({ tool: 'Tool', action: 'other' });
    should(request?.what).be.undefined();
  });

  it('reads a Claude dialog without a rule as a generic tool', () => {
    // Arrange
    const pane = ['Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request).containEql({
      harness: 'claude',
      tool: 'Tool',
      action: 'other',
      question: 'Do you want to proceed?',
    });
    should(request?.what).be.undefined();
    should(request?.detail).be.undefined();
  });

  it('reads an unknown Claude title as the tool, with its first body row as the subject', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Notebook edit', ['cell 3', 'changes']));

    // Assert
    should(request).containEql({ harness: 'claude', tool: 'Notebook edit', action: 'other', what: 'cell 3' });
  });

  it('reads `Tool use` without `(MCP)` as a plain tool, trimming the call’s trailing colon', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Tool use', ['lookup:', '│ finds a thing']));

    // Assert
    should(request).containEql({ tool: 'Tool', action: 'use', what: 'lookup', detail: 'finds a thing' });
  });

  it('reads a one-row `Tool use` body with no detail', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Tool use', ['lookup()']));

    // Assert
    should(request).containEql({ tool: 'Tool', action: 'use', what: 'lookup()' });
    should(request?.detail).be.undefined();
  });

  it('reads a `Tool use` dialog with no body at all', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Tool use', []));

    // Assert
    should(request).containEql({ tool: 'Tool', action: 'use' });
    should(request?.what).be.undefined();
  });

  it('reads a one-row Bash dialog as a command with no description', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Bash command', ['ls -la']));

    // Assert
    should(request).containEql({ tool: 'Bash', action: 'run', what: 'ls -la' });
    should(request?.detail).be.undefined();
  });

  it('strips the `Read(...)` wrapper from a read dialog', () => {
    // Act
    const request = parsePermissionPrompt(claudeDialog('Read file', ['Read(/etc/passwd)']));

    // Assert
    should(request).containEql({ tool: 'Read', action: 'read', what: '/etc/passwd' });
  });

  it('reads a Codex permissions request, with its reason as the detail', () => {
    // Act
    const request = parsePermissionPrompt(
      codexApproval('Would you like to grant these permissions?', ['Reason: needs the network']),
    );

    // Assert
    should(request).containEql({
      harness: 'codex',
      tool: 'Permissions',
      action: 'other',
      detail: 'needs the network',
    });
    should(request?.what).be.undefined();
  });

  it('reads an unknown Codex question as a generic Codex request about the row under it', () => {
    // Act
    const request = parsePermissionPrompt(codexApproval('Would you like to frobnicate?', ['something odd']));

    // Assert
    should(request).containEql({ harness: 'codex', tool: 'Codex', action: 'other', what: 'something odd' });
  });

  it('takes a Codex patch’s path from the `• Edited …` line when there is no Destination', () => {
    // Arrange
    const pane = [
      '• Edited src/app.ts (+3 -1)',
      '    1 +x',
      '  Would you like to make the following edits?',
      '› 1. Yes, proceed (y)',
      '  2. No, and tell Codex what to do differently (esc)',
    ].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request).containEql({ harness: 'codex', tool: 'Edit', action: 'edit', what: 'src/app.ts' });
  });

  it('clips every long value to its limit, ending in an ellipsis', () => {
    // Arrange
    const pane = claudeDialog(
      'Bash command',
      ['x'.repeat(600), 'd'.repeat(400)],
      `Do you want to ${'q'.repeat(400)}?`,
    ).replace('2. No', `2. ${'n'.repeat(400)}`);
    const long = claudeDialog('T'.repeat(200), ['subject']);

    // Act
    const request = parsePermissionPrompt(pane);
    const longTitle = parsePermissionPrompt(long);

    // Assert
    should(request?.what).equal(`${'x'.repeat(499)}…`);
    should(request?.detail).equal(`${'d'.repeat(299)}…`);
    should(request?.question).equal(`Do you want to ${'q'.repeat(284)}…`);
    should(request?.options[1]?.label).equal(`${'n'.repeat(299)}…`);
    should(longTitle?.tool).equal(`${'T'.repeat(119)}…`);
    should(PermissionRequestSchema.safeParse(request).success).be.true();
  });

  it('reads CRLF input the same as LF', () => {
    // Arrange
    const pane = fixture('codex-0.156.1-shell');

    // Act
    const crlf = parsePermissionPrompt(pane.replaceAll('\n', '\r\n'));

    // Assert
    should(crlf).eql(parsePermissionPrompt(pane));
    should(crlf?.what).equal('rm -rf build');
  });

  it('reads a question drawn inside a box gutter', () => {
    // Arrange
    const pane = [
      'some agent output',
      `│ ${'─'.repeat(30)} │`,
      '│ Bash command                  │',
      '│   ls                          │',
      '│                               │',
      '│ Do you want to proceed?       │',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');

    // Act
    const request = parsePermissionPrompt(pane);

    // Assert
    should(request).containEql({ tool: 'Bash', action: 'run', what: 'ls', question: 'Do you want to proceed?' });
  });
});

describe('permissionAnswerKeys', () => {
  const request = parsePermissionPrompt(fixture('claude-2.1.220-bash')) as NonNullable<
    ReturnType<typeof parsePermissionPrompt>
  >;

  it('answers a listed choice with its digit alone — no Enter', () => {
    // Act / Assert
    should(permissionAnswerKeys(request, { kind: 'choice', number: 2 })).equal('2');
    should(permissionAnswerKeys(request, { kind: 'choice', number: 3 })).equal('3');
  });

  it('answers nothing for a number the prompt does not list', () => {
    // Act / Assert
    should(permissionAnswerKeys(request, { kind: 'choice', number: 7 })).be.undefined();
    should(permissionAnswerKeys(request, { kind: 'choice', number: 4 })).be.undefined();
  });

  it('refuses with Escape', () => {
    // Act / Assert
    should(permissionAnswerKeys(request, { kind: 'deny' })).equal('\u001b');
  });
});

describe('paneBlockingPermission', () => {
  it('says nothing when the pane shows no permission prompt', () => {
    // Act / Assert
    should(paneBlockingPermission('just some output\n❯ ')).be.undefined();
  });

  it('names the tool, the first line of what it wants, and the question', () => {
    // Act / Assert
    should(paneBlockingPermission(fixture('claude-2.1.281-bash'))).equal(
      'Permission prompt — Bash curl -s https://example.com | head: Do you want to proceed?',
    );
    should(paneBlockingPermission(claudeDialog('Bash command', ['echo one', 'echo two', 'describes it']))).equal(
      'Permission prompt — Bash echo one: Do you want to proceed?',
    );
  });

  it('names only the tool when the prompt has no subject', () => {
    // Act / Assert
    should(paneBlockingPermission(fixture('claude-2.1.281-plan'))).equal('Permission prompt — Plan: Exit plan mode?');
  });

  it('clips the line at 200 characters', () => {
    // Arrange
    const pane = claudeDialog('Bash command', ['x'.repeat(400), 'describes it']);

    // Act
    const line = paneBlockingPermission(pane);

    // Assert
    should(line?.length).equal(200);
    should(line?.endsWith('…')).be.true();
    should(line?.startsWith('Permission prompt — Bash xxx')).be.true();
  });
});
