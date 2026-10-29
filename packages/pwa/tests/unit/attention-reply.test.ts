import { describe, expect, it } from 'bun:test';
import { DISMISS_ACTION, type InboxAction } from '../../src/lib/attention-inbox.ts';
import { defaultReplyTarget, withComposerNote } from '../../src/lib/attention-reply.ts';
import { attentionItem } from '../support/attention-inbox.tsx';

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

describe('defaultReplyTarget', () => {
  it('is the newest open item, or none', () => {
    const older = attentionItem('A1', { waitingSince: '2026-08-01T10:00:00.000Z' });
    const newer = attentionItem('A2', { waitingSince: '2026-08-01T12:00:00.000Z' });
    expect(defaultReplyTarget([older, newer])).toBe(newer);
    expect(defaultReplyTarget([newer, older])).toBe(newer);
    expect(defaultReplyTarget([])).toBeNull();
  });
});
