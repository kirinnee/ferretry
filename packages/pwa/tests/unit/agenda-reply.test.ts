import { describe, expect, it } from 'bun:test';
import { DISMISS_ACTION, type InboxAction } from '../../src/lib/agenda-inbox.ts';
import { withComposerNote } from '../../src/lib/agenda-reply.ts';

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
