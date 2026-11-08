import { describe, expect, test } from 'bun:test';
import { codexIndexNames, transcriptNames } from '../../../daemon/links/lib/conversation-name.ts';

const lines = (...records: unknown[]): string => records.map(record => JSON.stringify(record)).join('\n');

describe('transcriptNames for Claude', () => {
  test('keeps the owner’s name apart from the generated one, the latest of each kind winning', () => {
    const text = lines(
      { type: 'ai-title', aiTitle: 'First guess' },
      { type: 'custom-title', customTitle: 'Mine' },
      { type: 'summary', summary: 'A  summary\nof it' },
      { type: 'agent-name', agentName: 'zoe' },
      { type: 'custom-title', customTitle: '   ' },
      { type: 'ai-title', aiTitle: 42 },
    );
    expect(transcriptNames('claude', text)).toEqual({ chosen: 'zoe', generated: 'A summary of it' });
  });

  test('skips blank lines, lines that are not JSON, and values that are not records', () => {
    const text = `\n{not json\n"a string"\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Kept' })}\n`;
    expect(transcriptNames('claude', text)).toEqual({ generated: 'Kept' });
  });

  test('names nothing for a transcript that records no name', () => {
    expect(transcriptNames('claude', lines({ type: 'user' }))).toEqual({});
  });
});

describe('transcriptNames for Codex', () => {
  const rename = (name: unknown) => ({
    type: 'event_msg',
    payload: { type: 'thread_name_updated', thread_name: name },
  });

  test('takes the latest thread name as the owner’s, and ignores every other record', () => {
    const text = lines(
      rename('Old name'),
      { type: 'event_msg', payload: { type: 'other', thread_name: 'No' } },
      { type: 'event_msg', payload: null },
      { type: 'response_item', payload: { type: 'thread_name_updated', thread_name: 'Wrong type' } },
      rename('New name'),
      rename(''),
      { type: 'ai-title', aiTitle: 'A Claude record is not a Codex one' },
    );
    expect(transcriptNames('codex', text)).toEqual({ chosen: 'New name' });
  });
});

describe('codexIndexNames', () => {
  test('maps each conversation id to the latest name its index line gave it', () => {
    const text = lines(
      { id: 'a', thread_name: 'First', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'b', thread_name: 'Other' },
      { id: 'a', thread_name: 'Renamed' },
      { id: 'c', thread_name: '  ' },
      { thread_name: 'No id' },
      { id: 'd' },
    );
    expect([...codexIndexNames(text)]).toEqual([
      ['a', 'Renamed'],
      ['b', 'Other'],
    ]);
  });
});
