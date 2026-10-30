import { describe, expect, it } from 'bun:test';
import { DISMISS_ACTION, type InboxAction } from '../../src/lib/agenda-inbox.ts';
import { composerNoteFor, withComposerNote } from '../../src/lib/agenda-reply.ts';

const pick: InboxAction = {
  kind: 'respond',
  label: 'Postgres',
  response: { kind: 'multiple-choice', choice: 'Postgres' },
};

describe('withComposerNote', () => {
  it('attaches the composer text as a picked option’s note', () => {
    expect(withComposerNote(pick, '  keep it simple ')).toEqual({ ...pick, note: 'keep it simple' });
  });

  it('attaches it as a dismissal’s reason', () => {
    expect(withComposerNote(DISMISS_ACTION, 'already shipped')).toEqual({ ...DISMISS_ACTION, note: 'already shipped' });
  });

  it('leaves the action as it was for a blank composer', () => {
    expect(withComposerNote(pick, '   ')).toBe(pick);
  });

  it('joins a note the action already has', () => {
    expect(withComposerNote({ ...pick, note: 'first' }, 'second')).toEqual({ ...pick, note: 'first — second' });
  });

  it('leaves an answer that carries its own words, and a discuss, alone', () => {
    const own: InboxAction = { kind: 'respond', label: 'Reply', response: { kind: 'open-question', answer: 'mine' } };
    expect(withComposerNote(own, 'extra')).toBe(own);
    const discuss: InboxAction = { kind: 'discuss', label: 'Discuss' };
    expect(withComposerNote(discuss, 'extra')).toBe(discuss);
  });
});

describe('composerNoteFor', () => {
  it('never lets the composer ride on an input card, whose owner may have a password in it', () => {
    const note = composerNoteFor({ kind: 'input' }, 'hunter2-PASSWORD');

    expect(note).toBe('');
    expect(withComposerNote(DISMISS_ACTION, note)).toBe(DISMISS_ACTION);
  });

  it('hands the composer through for every other kind of item', () => {
    expect(composerNoteFor({ kind: 'task' }, 'already shipped')).toBe('already shipped');
  });
});
