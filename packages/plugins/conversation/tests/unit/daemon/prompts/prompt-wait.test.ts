import { describe, expect, test } from 'bun:test';
import {
  promptEntry,
  promptSubject,
  promptWait,
  readPrompt,
  promptKey,
} from '../../../../daemon/prompts/lib/prompt-wait.ts';

const permission = { id: '0123456789abcdef', tool: 'Bash', what: 'rm -rf build', question: 'Do you want to proceed?' };
const dialog = { id: 'fedcba9876543210', title: 'Make auto mode your default?' };

describe('what a ferret parked on a prompt is waiting on', () => {
  test('a permission prompt keeps the tool, what it is about and the question as its words, keyed by the prompt’s own id', () => {
    expect(promptWait({ turnState: 'needs-input', permissionRequest: permission })).toEqual({
      ref: { kind: 'permission', prompt: permission.id },
      words: 'Permission: Bash rm -rf build. Do you want to proceed?',
    });
  });

  test('a permission prompt that names nothing it is about is the tool alone', () => {
    const { what: _what, ...bare } = permission;
    expect(promptWait({ turnState: 'needs-input', permissionRequest: bare })?.words).toBe(
      'Permission: Bash. Do you want to proceed?',
    );
  });

  test('a harness dialog is read when there is no permission prompt', () => {
    expect(promptWait({ turnState: 'needs-input', dialog })).toEqual({
      ref: { kind: 'dialog', prompt: dialog.id },
      words: 'Dialog: Make auto mode your default?',
    });
  });

  test('the pane’s own words are the last resort, kept whole on one line and keyed by a digest of all of them', () => {
    const long = `Trust\nthis folder? ${'x'.repeat(400)}`;
    const wait = promptWait({ turnState: 'needs-input', prompt: long });
    expect(wait?.ref.kind).toBe('prompt');
    expect(wait?.ref.prompt).toMatch(/^[0-9a-f]{32}$/u);
    expect(wait?.words).toHaveLength('Trust this folder? '.length + 400);
    expect(wait?.words).not.toContain('\n');
    expect(promptWait({ turnState: 'needs-input', prompt: 'Trust this folder?' })?.words).toBe('Trust this folder?');
  });

  test('two long prompts that share their first 239 characters are two different waits', () => {
    const prefix = 'x'.repeat(300);
    const first = promptWait({ turnState: 'needs-input', prompt: `${prefix} first` });
    const second = promptWait({ turnState: 'needs-input', prompt: `${prefix} second` });
    expect(first?.ref).not.toEqual(second?.ref);
    expect(promptKey(first!.ref)).not.toBe(promptKey(second!.ref));
  });

  test('whitespace alone does not make a prompt another prompt', () => {
    expect(promptWait({ turnState: 'needs-input', prompt: 'Trust   this\nfolder?' })?.ref).toEqual(
      promptWait({ turnState: 'needs-input', prompt: ' Trust this folder? ' })?.ref,
    );
  });

  test('a permission prompt wins over a dialog behind the same wait', () => {
    expect(promptWait({ turnState: 'needs-input', permissionRequest: permission, dialog })?.ref.kind).toBe(
      'permission',
    );
  });

  test('a ferret that is not parked on a prompt waits on nothing here: a question is its own card', () => {
    expect(promptWait(undefined)).toBeUndefined();
    expect(promptWait({ turnState: 'working', permissionRequest: permission })).toBeUndefined();
    expect(promptWait({ turnState: 'needs-input' })).toBeUndefined();
    expect(promptWait({ turnState: 'needs-input', prompt: '  ' })).toBeUndefined();
    expect(promptWait({ turnState: 'needs-input', permissionRequest: { id: 1 }, dialog: 'x' })).toBeUndefined();
  });
});

describe('what one look at a pane means for the card', () => {
  test('a parked pane is waiting', () => {
    expect(readPrompt({ turnState: 'needs-input', permissionRequest: permission }).kind).toBe('waiting');
  });

  test('a pane that is working, or at the owner’s turn, or parked on a question of its own, positively ended the wait', () => {
    expect(readPrompt({ turnState: 'working' })).toEqual({ kind: 'ended' });
    expect(readPrompt({ turnState: 'your-turn' })).toEqual({ kind: 'ended' });
    expect(readPrompt({ turnState: 'needs-input' })).toEqual({ kind: 'ended' });
  });

  test('nothing recorded or nothing readable is no evidence either way', () => {
    expect(readPrompt(undefined)).toEqual({ kind: 'unknown' });
    expect(readPrompt({})).toEqual({ kind: 'unknown' });
  });
});

describe('the card’s subject and the entry it is kept under on the Agenda', () => {
  test('the subject is v4’s generic words by kind; the prompt’s own words are the context, not the subject', () => {
    expect(promptSubject('f1', { kind: 'permission', prompt: 'a' })).toBe('f1 needs a permission answer');
    expect(promptSubject('f1', { kind: 'dialog', prompt: 'a' })).toBe('f1 needs an answer to a dialog');
    expect(promptSubject('f1', { kind: 'prompt', prompt: 'a' })).toBe('f1 needs an answer');
  });

  test('the entry is the same for the same prompt, occurrence and ferret, and another for any other', () => {
    const ref = { kind: 'permission', prompt: permission.id } as const;
    expect(promptEntry('lead', ref, 1)).toMatch(/^p:[0-9a-f]{40}$/u);
    expect(promptEntry('lead', ref, 1)).toBe(promptEntry('lead', ref, 1));
    expect(promptEntry('lead', ref, 2)).not.toBe(promptEntry('lead', ref, 1));
    expect(promptEntry('other', ref, 1)).not.toBe(promptEntry('lead', ref, 1));
    expect(promptEntry('lead', { kind: 'dialog', prompt: permission.id }, 1)).not.toBe(promptEntry('lead', ref, 1));
  });
});
