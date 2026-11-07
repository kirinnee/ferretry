import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { renameErrorsFor, renamePatch } from '../../../app/components/rename-sheet.tsx';
import { sessionView } from '../support/sessions.ts';

const source = (parent = 'lead'): SessionView =>
  sessionView('same-session', {
    config: { name: 'Original Task', teammate: 'original', ...(parent ? { parent } : {}) },
  });

describe('renamePatch', () => {
  it('normalises changed fields, detaches only a real child, and omits unchanged values', () => {
    expect(renamePatch(source(), ' Original Task ', ' ORIGINAL ', false)).toEqual({});
    expect(renamePatch(source(), '  Better Task  ', ' New-Name ', true)).toEqual({
      name: 'Better Task',
      teammate: 'new-name',
      clearParent: true,
    });
    expect(renamePatch(source(''), 'Original Task', 'original', true)).toEqual({});
  });

  it('places named daemon failures beside their field and leaves unknown failures at form level', () => {
    expect(renameErrorsFor(new Error('callsign already belongs to a teammate'))).toEqual({
      teammate: 'callsign already belongs to a teammate',
    });
    expect(renameErrorsFor(new Error('task title is too long'))).toEqual({ title: 'task title is too long' });
    expect(renameErrorsFor('daemon offline')).toEqual({ form: 'daemon offline' });
  });
});
