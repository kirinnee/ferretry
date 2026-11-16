import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dialogCursorMoves, parseHarnessDialog, recordedDialogId } from '../../../daemon/lib/pane/harness-dialog.ts';
import {
  parsePermissionPrompt,
  permissionAnswerKeys,
  recordedPermissionId,
} from '../../../daemon/lib/pane/permission-prompt.ts';

/**
 * Codex's permission prompts and dialogs, read off real panes of Codex 0.145.0, 0.156.1, 0.163.0 and 0.164.0 (the
 * fixtures are v4's, copied from Terminals'). The permission and dialog answers go through ONE service for either
 * harness, so this plugin's parsers must read both: a harness that parses to `undefined` here would answer 409 gone.
 */

const fixture = (folder: string, name: string): string =>
  readFileSync(join(import.meta.dir, '../../fixtures', folder, `${name}.txt`), 'utf8');

const SHELL_OPTIONS = [
  { number: 1, label: 'Yes, proceed', kind: 'allow' },
  { number: 2, label: "Yes, and don't ask again for commands that start with `rm -rf build`", kind: 'allow-always' },
  { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
];
const PATCH_OPTIONS = [
  { number: 1, label: 'Yes, proceed', kind: 'allow' },
  { number: 2, label: "Yes, and don't ask again for these files", kind: 'allow-always' },
  { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
];

describe('Codex permission prompts, read by the Claude Code plugin’s parser', () => {
  const cases = [
    ['codex-0.145.0-shell', 'Shell', 'run', 'rm -rf build', SHELL_OPTIONS],
    ['codex-0.156.1-shell', 'Shell', 'run', 'rm -rf build', SHELL_OPTIONS],
    ['codex-0.164.0-shell', 'Shell', 'run', 'rm -rf build', SHELL_OPTIONS],
    ['codex-0.145.0-patch', 'Edit', 'edit', 'hello.txt', PATCH_OPTIONS],
    ['codex-0.156.1-patch', 'Edit', 'edit', '/home/dev/project/hello.txt', PATCH_OPTIONS],
    ['codex-0.164.0-patch', 'Edit', 'edit', '/home/dev/project/hello.txt', PATCH_OPTIONS],
  ] as const;

  for (const [name, tool, action, what, options] of cases) {
    it(`${name}: a ${tool} ${action} of ${what}, three rows, the cursor on the first`, () => {
      const request = parsePermissionPrompt(fixture('codex-permission-prompts', name));

      expect(request).toMatchObject({ harness: 'codex', tool, action, what, selected: 1 });
      expect(request?.options).toEqual(options as never);
    });

    it(`${name}: the id the runner records for it is the id this parser reads`, () => {
      const request = parsePermissionPrompt(fixture('codex-permission-prompts', name));

      expect(request).toBeDefined();
      expect(recordedPermissionId(request as never)).toBe(request?.id as string);
    });
  }

  it('answers a choice with arrows and Enter, and a refusal with Escape alone', () => {
    const request = parsePermissionPrompt(fixture('codex-permission-prompts', 'codex-0.156.1-shell'));

    expect(permissionAnswerKeys(request as never, { kind: 'choice', number: 3 })).toEqual({
      moves: ['Down', 'Down'],
      confirm: 'Enter',
    });
    expect(permissionAnswerKeys(request as never, { kind: 'deny' })).toEqual({ moves: [], confirm: 'Escape' });
    expect(permissionAnswerKeys(request as never, { kind: 'choice', number: 9 })).toBeUndefined();
  });

  const codexQuestion = (question: string, detail: readonly string[]): string =>
    [
      '  >_ OpenAI Codex (v0.164.0)',
      '',
      `  ${question}`,
      '',
      ...detail,
      '',
      '› 1. Yes, proceed (y)',
      '  2. No, and tell Codex what to do differently (esc)',
      '',
      '  Press enter to confirm or esc to cancel',
    ].join('\n');

  it('reads a request for more permissions as a Permissions prompt whose reason is the detail', () => {
    const request = parsePermissionPrompt(
      codexQuestion('Would you like to grant these permissions?', ['  Reason: Needs network access']),
    );

    expect(request).toMatchObject({
      harness: 'codex',
      tool: 'Permissions',
      action: 'other',
      detail: 'Needs network access',
      selected: 1,
    });
    expect(request?.what).toBeUndefined();
  });

  it('reads a Codex question it has no name for as a generic Codex prompt, the first line under it as the subject', () => {
    const request = parsePermissionPrompt(
      codexQuestion('Would you like to open the pod bay doors?', ['  Doors: pod bay', '  Reason: Hal asked']),
    );

    expect(request).toMatchObject({
      harness: 'codex',
      tool: 'Codex',
      action: 'other',
      what: 'Doors: pod bay',
      detail: 'Hal asked',
      selected: 1,
    });
  });

  it('does not take a Codex composer under a numbered list for a prompt', () => {
    const idle = ['Do you want to proceed?', '  1. Yes', '  2. No', '', '› Ask Codex to do anything'].join('\n');

    expect(parsePermissionPrompt(idle)).toBeUndefined();
  });
});

describe('Codex dialogs, read by the Claude Code plugin’s parser', () => {
  const cases = [
    ['codex-0.145.0-hooks-review', 'hooks-review', 'Hooks need review', 'go back'],
    ['codex-0.156.1-hooks-review', 'hooks-review', 'Hooks need review', 'skip'],
    ['codex-0.156.1-hooks-list', 'hooks-list', 'Hooks', 'close'],
    ['codex-0.156.1-update', 'update', undefined, undefined],
    ['codex-0.156.1-sign-in', 'sign-in', undefined, undefined],
    ['codex-0.163.0-directory-trust', 'directory-trust', 'Folder access', 'back'],
    ['codex-0.163.0-directory-restricted', 'directory-trust', 'Folder access', 'back'],
  ] as const;

  for (const [name, kind, title, escapeLabel] of cases) {
    it(`${name}: a ${kind} dialog`, () => {
      const dialog = parseHarnessDialog(fixture('codex-harness-dialogs', name));

      expect(dialog).toMatchObject({ harness: 'codex', kind });
      if (title !== undefined) expect(dialog?.title).toBe(title);
      if (escapeLabel !== undefined) expect(dialog?.escape).toBe(escapeLabel);
    });

    it(`${name}: the id the runner records for it is the id this parser reads`, () => {
      const dialog = parseHarnessDialog(fixture('codex-harness-dialogs', name));

      expect(recordedDialogId(dialog as never)).toBe(dialog?.id as string);
    });
  }

  it('moves a Codex cursor with arrows, never a digit', () => {
    const dialog = parseHarnessDialog(fixture('codex-harness-dialogs', 'codex-0.156.1-hooks-review'));

    expect(dialogCursorMoves(dialog as never, 2)).toEqual(['Down']);
  });
});
