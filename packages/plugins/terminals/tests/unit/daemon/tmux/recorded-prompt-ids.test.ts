import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHarnessDialog } from '../../../../daemon/lib/tmux/harness-dialog.ts';
import { parsePermissionPrompt } from '../../../../daemon/lib/tmux/permission-prompt.ts';

/**
 * THE IDS FERRETS RECORDS. This runner's look gives a prompt the id Ferrets keeps in a ferret's state document and a card
 * answers with. Claude Code's answer route re-reads the pane with its own parser and accepts this id (it rebuilds it from
 * what it reads); the same table is pinned there, so neither side can change its digest alone.
 */

const RECORDED_PERMISSION_IDS: Readonly<Record<string, string>> = {
  'claude-2.1.220-bash': '2f9b842207f54ff4',
  'claude-2.1.220-edit': '192081887640b472',
  'claude-2.1.220-mcp': 'cfe6b47ae5404258',
  'claude-2.1.220-plan': 'a68f676ae432c4c4',
  'claude-2.1.220-read-outside': '8369ab4762ba8af5',
  'claude-2.1.220-webfetch': '1942d0f2acc905a0',
  'claude-2.1.220-write-outside': '0b2506d5198588bb',
  'claude-2.1.220-write': '3583938eb56e2abc',
  'claude-2.1.281-bash': '9bdb6c2bfeab1469',
  'claude-2.1.281-edit': '67c685639623244d',
  'claude-2.1.281-mcp': '157f40c3f50ccfa5',
  'claude-2.1.281-plan': 'a0e5c3aae23f54b8',
  'claude-2.1.281-read-outside': '15e254453e01352b',
  'claude-2.1.281-webfetch': '1942d0f2acc905a0',
  'claude-2.1.281-write-outside': '54bbc7b8c8e89dba',
  'claude-2.1.281-write': '019f23216845e9af',
};

const RECORDED_DIALOG_IDS: Readonly<Record<string, string>> = {
  'claude-2.1.220-mcp-servers': '1059ab450a27f463',
  'claude-2.1.220-settings-error': 'd22104f390283939',
  'claude-2.1.281-mcp-servers': '1059ab450a27f463',
  'claude-2.1.281-settings-error': 'd22104f390283939',
  'claude-2.1.281-spend-limit': '0db532a36ff416f9',
};

const frame = (dir: string, name: string): string =>
  readFileSync(join(import.meta.dir, '../../../fixtures', dir, `${name}.txt`), 'utf8');

describe('the id this runner gives a captured Claude Code prompt', () => {
  test.each(Object.entries(RECORDED_PERMISSION_IDS))('permission %s', (name, recorded) => {
    const read = parsePermissionPrompt(frame('permission-prompts', name));
    expect(read?.id).toBe(recorded);
    expect(read?.harness).toBe('claude');
  });

  test.each(Object.entries(RECORDED_DIALOG_IDS))('dialog %s', (name, recorded) => {
    const read = parseHarnessDialog(frame('harness-dialogs', name));
    expect(read?.id).toBe(recorded);
    expect(read?.harness).toBe('claude');
  });
});
