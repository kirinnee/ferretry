import { describe, expect, test } from 'bun:test';
import { saveKeepInSync } from '../../../app/lib/conversation-file.ts';
import { scripted } from './support/client.ts';

const FILE = (text: string) => ({ path: 'conversation.yaml', exists: true, text, etag: 'e1' });

describe('"Keep in sync" is saved into conversation.yaml as text', () => {
  test('a file that is not a mapping cannot take the switch, so nothing is written and it is reported broken', async () => {
    const calls: { route: string }[] = [];
    const client = scripted(
      { 'GET /v1/config/file': FILE('just some words'), 'PUT /v1/config/file': {} },
      calls as never,
    );

    expect(await saveKeepInSync(client, false)).toBe('broken');
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file']);
  });
});
