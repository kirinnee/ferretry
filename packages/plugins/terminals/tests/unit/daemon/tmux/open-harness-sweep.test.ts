import { describe, expect, test } from 'bun:test';
import { RECORDED_HARNESS_KEYS, RecordedHarnessSchema } from '@ferretry/core-ferrets/contract';
import { HarnessSchema } from '../../../../daemon/lib/protocol/harness.ts';
import { GUARDED_HARNESS_NAMES } from '../../../../daemon/lib/tmux/harness-guard.ts';
import { parsePermissionPrompt } from '../../../../daemon/lib/tmux/permission-prompt.ts';
import { codexUpdateAction } from '../../../../daemon/lib/tmux/startup.ts';

/**
 * U4b part 4b, Terminals. The screen parsers read the two TUIs this build ships; what they name a screen is Ferrets' family
 * table, not a copy of it, so a family added there is a family each of these has to say something about.
 */

describe('the harness family the terminal protocol names', () => {
  test('is Ferrets own family table, not a second list of the same two words', () => {
    expect(HarnessSchema).toBe(RecordedHarnessSchema);
    expect(HarnessSchema.options).toEqual(['claude', 'codex']);
  });

  test('the launch guard resolves one command per family the table names', () => {
    expect(GUARDED_HARNESS_NAMES).toHaveLength(RECORDED_HARNESS_KEYS.length);
    expect([...GUARDED_HARNESS_NAMES]).toEqual(['claude', 'codex']);
  });
});

describe('the screens each family draws', () => {
  const claudeScreen = [
    '  Bash command',
    '',
    '    ls /tmp',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for ls commands',
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const codexScreen = [
    '  Would you like to run the following command?',
    '',
    '  $ ls /tmp',
    '',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don’t ask again for this command (p)',
    '  3. No, and tell Codex what to do differently (esc)',
  ].join('\n');

  test('a Claude prompt is read as Claude and a Codex prompt as Codex, as before', () => {
    expect(parsePermissionPrompt(claudeScreen)?.harness).toBe('claude');
    expect(parsePermissionPrompt(codexScreen)?.harness).toBe('codex');
  });

  test('a screen no parser here knows is read as nothing at all', () => {
    expect(parsePermissionPrompt('some other harness\n  just a composer\n> ')).toBeUndefined();
    expect(codexUpdateAction('some other harness\n  just a composer\n> ')).toBeUndefined();
  });
});
