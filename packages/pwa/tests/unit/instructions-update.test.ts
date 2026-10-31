import { describe, expect, test } from 'bun:test';
import { parseInstructionsUpdate } from '../../src/lib/instructions-update.ts';

const NOTE = [
  '[instructions updated] Ferretry changed part of the instructions you were started with. Follow these words in place of the matching part of your system prompt:',
  'Ferretry tools: you can open terminals.',
  'Board: all work is a card.\n\nSecond paragraph of the board rule.',
].join('\n\n');

describe('parseInstructionsUpdate', () => {
  test('names each changed section and drops the lead-in addressed to the agent', () => {
    const update = parseInstructionsUpdate(NOTE);
    expect(update?.headline).toBe('Ferretry · Instructions updated · Ferretry tools, Board');
    expect(update?.sections.map(section => section.label)).toEqual(['Ferretry tools', 'Board']);
    expect(update?.sections[1]?.text).toBe('Board: all work is a card.\n\nSecond paragraph of the board rule.');
  });

  test('is null for any other message, including one that merely mentions the mark', () => {
    expect(parseInstructionsUpdate('please follow [instructions updated]')).toBeNull();
    expect(parseInstructionsUpdate('hello')).toBeNull();
  });

  test('a note with no sections still reads as an update, without a section list', () => {
    const update = parseInstructionsUpdate('[instructions updated] Ferretry changed part of them:');
    expect(update).toEqual({ sections: [], headline: 'Ferretry · Instructions updated' });
  });

  test('text before any labelled paragraph becomes a generic section', () => {
    const update = parseInstructionsUpdate('[instructions updated] lead-in\n\nno label here');
    expect(update?.sections).toEqual([{ label: 'Instructions', text: 'no label here' }]);
  });
});

describe('parseInstructionsUpdate from the sender metadata', () => {
  const BODY = NOTE.replace('[instructions updated] ', '');

  test('a note from the Instructions sender needs no tag and is headed by the sections its text names', () => {
    const update = parseInstructionsUpdate(BODY, { feature: 'Instructions', sections: ['Tools', 'Board'] });
    expect(update?.headline).toBe('Ferretry · Instructions updated · Ferretry tools, Board');
    expect(update?.sections.map(section => section.label)).toEqual(['Ferretry tools', 'Board']);
  });

  test('without section names it falls back to the labels it can read', () => {
    const update = parseInstructionsUpdate(BODY, { feature: 'Instructions' });
    expect(update?.headline).toBe('Ferretry · Instructions updated · Ferretry tools, Board');
  });

  test('another sender is not an instructions note, tag or no tag', () => {
    expect(parseInstructionsUpdate(BODY, { feature: 'Board' })).toBeNull();
    expect(parseInstructionsUpdate(BODY)).toBeNull();
  });

  test('the old tag still wins for history even when the sender is silent', () => {
    expect(parseInstructionsUpdate(NOTE, { sections: ['Board'] })?.headline).toBe(
      'Ferretry · Instructions updated · Ferretry tools, Board',
    );
  });
});
