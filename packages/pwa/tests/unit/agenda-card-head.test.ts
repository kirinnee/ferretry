import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { agendaCardHead } from '../../src/lib/agenda-card-head.ts';
import { agendaItem, choices } from '../support/agenda-inbox.tsx';

const head = (extra: Partial<AgendaItem>) => agendaCardHead(agendaItem('A5', extra));

describe('what an open item says above and atop its card', () => {
  test('the title, then the ask as the one-line description, then the one question asked', () => {
    expect(
      head({
        title: 'Spend limit',
        subject: 'One rule left before spend limits ship.',
        ask: choices('Pause', 'Warn'),
        questions: [{ question: 'At the hard limit, what should happen?' }],
      }),
    ).toEqual({
      title: 'Spend limit',
      description: 'One rule left before spend limits ship.',
      question: 'At the hard limit, what should happen?',
    });
  });

  test('an old item whose title is its ask falls back to its why, and asks its ask', () => {
    expect(head({ subject: 'Ship it?', why: 'The release is due.', ask: choices('Yes', 'No') })).toEqual({
      title: 'Ship it?',
      description: 'The release is due.',
      question: null,
    });
  });

  test('a why that only repeats the ask, or a blank one, is no description', () => {
    expect(head({ subject: 'Ship it?', why: 'Ship it?' }).description).toBeNull();
  });

  test('with no question, an item that asks states nothing twice; a to-do or a note states no question', () => {
    expect(head({ title: 'Engine', subject: 'Which engine?', ask: choices('A', 'B') }).question).toBeNull();
    expect(
      head({ title: 'Rotate', subject: 'Rotate the key.', kind: 'task', ask: { kind: 'task' } }).question,
    ).toBeNull();
    expect(head({ title: 'Done', subject: 'It shipped.', kind: 'info' }).question).toBeNull();
  });

  test('a question that only repeats the description or the title is not said again', () => {
    expect(
      head({ title: 'Engine', subject: 'Which engine?', questions: [{ question: 'Which engine?' }] }).question,
    ).toBeNull();
  });
});
