import { describe, expect, it } from 'bun:test';
import { type PermissionRequest, permissionOptionWords, permissionWords } from '../../../app/lib/permission-request.ts';

const request = (action: PermissionRequest['action'], what?: string, tool = 'Bash'): PermissionRequest => ({
  id: 'r1',
  harness: 'claude-code',
  tool,
  action,
  ...(what === undefined ? {} : { what }),
  question: 'Do you want to proceed?',
  options: [],
  selected: 1,
});

describe('permissionWords', () => {
  it('splits the sentence where the command or path begins', () => {
    expect(permissionWords('zoe', request('read', '/etc/hostname'))).toEqual({
      lead: 'zoe wants to read',
      what: '/etc/hostname',
    });
  });

  it('names what the action is when the prompt names no command, path or URL', () => {
    expect(permissionWords('zoe', request('run')).lead).toBe('zoe wants to run a command');
    expect(permissionWords('zoe', request('read')).lead).toBe('zoe wants to read a file');
    expect(permissionWords('zoe', request('edit')).lead).toBe('zoe wants to edit a file');
    expect(permissionWords('zoe', request('create')).lead).toBe('zoe wants to create a file');
    expect(permissionWords('zoe', request('fetch')).lead).toBe('zoe wants to fetch a web page');
  });

  it('quotes a command in the sentence when it is told as one phrase', () => {
    expect(permissionWords('zoe', request('use', undefined, 'Grep')).lead).toBe('zoe wants to use Grep');
    expect(permissionWords('zoe', request('use', 'the search', 'Grep'))).toEqual({
      lead: 'zoe wants to use',
      what: 'the search',
    });
  });

  it('words a plan exit and an unknown tool without a subject for them', () => {
    expect(permissionWords('zoe', request('exit-plan', 'ignored')).lead).toBe('zoe wants to exit plan mode and start');
    expect(permissionWords('zoe', request('other', undefined, 'Mystery')).lead).toBe(
      'zoe needs permission to use Mystery',
    );
  });
});

describe('permissionOptionWords', () => {
  it('keeps the harness’s own label, and shows it as the secondary only for Always allow', () => {
    expect(permissionOptionWords({ number: 1, label: 'Yes', kind: 'allow' })).toEqual({
      label: 'Allow once',
      harness: 'Yes',
    });
    expect(permissionOptionWords({ number: 2, label: 'Yes, and do not ask again', kind: 'allow-always' })).toEqual({
      label: 'Always allow',
      secondary: 'Yes, and do not ask again',
      harness: 'Yes, and do not ask again',
    });
    expect(permissionOptionWords({ number: 3, label: 'No', kind: 'deny' }).label).toBe('Deny');
  });
});
