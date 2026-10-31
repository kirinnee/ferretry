import { describe, expect, it } from 'bun:test';
import { DISMISS_ACTION, type InboxAction } from '../../src/lib/agenda-inbox.ts';
import { composerNoteFor, inputDraftDiscarded, withComposerNote } from '../../src/lib/agenda-reply.ts';

const pick: Extract<InboxAction, { kind: 'respond' }> = {
  kind: 'respond',
  label: 'Postgres',
  response: { kind: 'multiple-choice', choice: 'Postgres' },
};

describe('withComposerNote', () => {
  it('attaches the composer text as a picked option’s note', () => {
    expect(withComposerNote(pick, '  keep it simple ')).toEqual({ ...pick, note: 'keep it simple' });
  });

  it('attaches it as a dismissal’s reason', () => {
    expect(withComposerNote(DISMISS_ACTION, 'already shipped')).toEqual({
      kind: 'dismiss',
      label: DISMISS_ACTION.label,
      note: 'already shipped',
    });
  });

  it('leaves the action as it was for a blank composer', () => {
    expect(withComposerNote(pick, '   ')).toBe(pick);
  });

  it('takes Request changes as already holding the composer words, and spends the composer', () => {
    const clarify: InboxAction = {
      kind: 'respond',
      label: 'Request changes',
      response: { kind: 'answer-review', verdict: 'clarify', clarification: 'bigger button' },
    };
    const sent = withComposerNote(clarify, 'bigger button');
    expect(sent).toEqual(clarify);
    expect(sent).not.toBe(clarify);
  });

  it('joins a note the action already has', () => {
    expect(withComposerNote({ ...pick, note: 'first' }, 'second')).toEqual({ ...pick, note: 'first — second' });
  });

  it('never attaches the composer to a snooze or an unsnooze', () => {
    const snooze: InboxAction = { kind: 'snooze', label: 'Snooze', until: '2026-10-30T15:00:00.000Z' };
    const unsnooze: InboxAction = { kind: 'unsnooze', label: 'Back to my list' };
    expect(withComposerNote(snooze, 'extra')).toBe(snooze);
    expect(withComposerNote(unsnooze, 'extra')).toBe(unsnooze);
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

describe('inputDraftDiscarded', () => {
  it('empties the composer for an input card with anything in it, spaces included', () => {
    expect(inputDraftDiscarded({ kind: 'input' }, 'hunter2')).toBe(true);
    expect(inputDraftDiscarded({ kind: 'input' }, '   ')).toBe(true);
  });

  it('leaves an empty composer, and every other kind, alone', () => {
    expect(inputDraftDiscarded({ kind: 'input' }, '')).toBe(false);
    expect(inputDraftDiscarded({ kind: 'task' }, 'text')).toBe(false);
  });
});
