import { describe, expect, test } from 'bun:test';
import { promptEntry, promptWait } from '../../../../daemon/prompts/lib/prompt-wait.ts';

const permission = { id: '0123456789abcdef', tool: 'Bash', what: 'rm -rf build', question: 'Do you want to proceed?' };
const dialog = { id: 'fedcba9876543210', title: 'Make auto mode your default?' };

describe('what a ferret parked on a prompt is waiting on', () => {
  test('a permission prompt names the tool and what it is about, keyed by the prompt’s own id', () => {
    expect(promptWait({ turnState: 'needs-input', permissionRequest: permission })).toEqual({
      ref: { kind: 'permission', prompt: permission.id },
      subject: 'Permission: Bash rm -rf build',
    });
  });

  test('a permission prompt that names nothing it is about is the tool alone', () => {
    const { what: _what, ...bare } = permission;
    expect(promptWait({ turnState: 'needs-input', permissionRequest: bare })?.subject).toBe('Permission: Bash');
  });

  test('a harness dialog is read when there is no permission prompt', () => {
    expect(promptWait({ turnState: 'needs-input', dialog })).toEqual({
      ref: { kind: 'dialog', prompt: dialog.id },
      subject: 'Dialog: Make auto mode your default?',
    });
  });

  test('the pane’s own words are the last resort, one bounded line keyed by a digest of them', () => {
    const wait = promptWait({ turnState: 'needs-input', prompt: `Trust\nthis folder? ${'x'.repeat(400)}` });
    expect(wait?.ref.kind).toBe('prompt');
    expect(wait?.ref.prompt).toMatch(/^[0-9a-f]{16}$/u);
    expect(wait?.subject).toHaveLength(240);
    expect(wait?.subject).not.toContain('\n');
    expect(promptWait({ turnState: 'needs-input', prompt: 'Trust this folder?' })?.subject).toBe('Trust this folder?');
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

describe('the entry a prompt is kept under on the Agenda', () => {
  test('is the same for the same prompt of the same ferret, and another for another ferret or another prompt', () => {
    const ref = { kind: 'permission', prompt: permission.id } as const;
    expect(promptEntry('lead', ref)).toMatch(/^p:[0-9a-f]{40}$/u);
    expect(promptEntry('lead', ref)).toBe(promptEntry('lead', ref));
    expect(promptEntry('other', ref)).not.toBe(promptEntry('lead', ref));
    expect(promptEntry('lead', { kind: 'dialog', prompt: permission.id })).not.toBe(promptEntry('lead', ref));
  });
});
