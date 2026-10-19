import { describe, expect, it } from 'bun:test';
import { CONVERSATION_ADOPT_PATH, CONVERSATION_IMPORT_PATH } from '@ferretry/protocol';
import {
  adoptConversations,
  readConversationPreview,
  readImportableConversations,
} from '../../../../../src/features/fleet/conversations/conversations-api.ts';
import { type Call, scripted } from '../account-support.ts';
import { conversation, listing } from './conversation-support.ts';

describe('conversations api', () => {
  it('reads the listing with no query string when nothing narrows it', async () => {
    const calls: Call[] = [];
    const client = scripted({ [`GET ${CONVERSATION_IMPORT_PATH}`]: listing([conversation('a')]) }, calls);
    const read = await readImportableConversations(client);
    expect(read.conversations.map(row => row.id)).toEqual(['a']);
    expect(calls[0]?.path).toBe(CONVERSATION_IMPORT_PATH);
  });

  it('sends only the narrowing it has', async () => {
    const calls: Call[] = [];
    const path = `${CONVERSATION_IMPORT_PATH}?harness=codex&q=shop+page&limit=20`;
    const client = scripted({ [`GET ${path}`]: listing([]) }, calls);
    await readImportableConversations(client, { harness: 'codex', q: 'shop page', limit: 20 });
    expect(calls[0]?.path).toBe(path);
  });

  it('reads one conversation’s preview at its own address', async () => {
    const calls: Call[] = [];
    const preview = { id: 'a-1', harness: 'codex' as const, messages: [{ role: 'user' as const, text: 'Hi' }] };
    const client = scripted({ [`GET ${CONVERSATION_IMPORT_PATH}/codex/a-1/preview`]: preview }, calls);
    expect(await readConversationPreview(client, 'codex', 'a-1')).toEqual(preview);
    expect(calls[0]?.path).toBe(`${CONVERSATION_IMPORT_PATH}/codex/a-1/preview`);
  });

  it('posts a parsed adoption, filling start in as off', async () => {
    const calls: Call[] = [];
    const answer = { adopted: [{ id: 'a', session: 's-1', name: 'shop-fix', status: 'stopped' }], refused: [] };
    const client = scripted({ [`POST ${CONVERSATION_ADOPT_PATH}`]: answer }, calls);
    const result = await adoptConversations(client, {
      harness: 'claude',
      runtime: 'claude-default',
      conversations: [{ id: 'a' }],
    });
    expect(result.adopted[0]?.session).toBe('s-1');
    expect(calls[0]).toEqual({
      method: 'POST',
      path: CONVERSATION_ADOPT_PATH,
      headers: { 'content-type': 'application/json' },
      body: { harness: 'claude', runtime: 'claude-default', conversations: [{ id: 'a', start: false }] },
    });
  });

  it('refuses an adoption that starts more than ten before sending it', async () => {
    const calls: Call[] = [];
    const client = scripted({}, calls);
    const conversations = Array.from({ length: 11 }, (_, index) => ({ id: `c${index}`, start: true }));
    await expect(adoptConversations(client, { harness: 'claude', runtime: 'r', conversations })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
