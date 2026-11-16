import { describe, expect, it } from 'bun:test';
import {
  keepConversations,
  readConversationPreview,
  readLinkableConversations,
} from '../../../../app/links/conversations-api.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { conversation, listing } from '../../../support/app/links.ts';

const LISTING = 'GET /v1/links/conversations';
const PREVIEW = 'GET /v1/links/conversations/:harness/:conversationId/preview';
const KEEP = 'POST /v1/links/conversations/keep';

describe('conversations api', () => {
  it('reads the listing with no query when nothing narrows it', async () => {
    const client = fakeClient({ [LISTING]: () => listing([conversation('a')]) });
    const read = await readLinkableConversations(client);
    expect(read.conversations.map(row => row.id)).toEqual(['a']);
    expect(client.calls[0]?.route).toBe(LISTING);
    expect(client.calls[0]?.query).toEqual({});
  });

  it('sends only the narrowing it has', async () => {
    const client = fakeClient({ [LISTING]: () => listing([]) });
    await readLinkableConversations(client, { harness: 'codex', q: 'shop page', limit: 20 });
    expect(client.calls[0]?.query).toEqual({ harness: 'codex', q: 'shop page', limit: '20' });
  });

  it('reads one conversation’s preview at its own address', async () => {
    const preview = { id: 'a-1', harness: 'codex', messages: [{ role: 'user' as const, text: 'Hi' }] };
    const client = fakeClient({ [PREVIEW]: () => preview });
    expect(await readConversationPreview(client, 'codex', 'a-1')).toEqual(preview);
    expect(client.calls[0]?.params).toEqual({ harness: 'codex', conversationId: 'a-1' });
  });

  it('posts a parsed keep, filling start in as off', async () => {
    const answer = { kept: [{ id: 'a', ferret: 's-1', name: 'shop-fix', state: 'stopped' }], refused: [] };
    const client = fakeClient({ [KEEP]: () => answer });
    const result = await keepConversations(client, {
      harness: 'claude-code',
      runtime: 'claude-default',
      conversations: [{ id: 'a' }],
    });
    expect(String(result.kept[0]?.ferret)).toBe('s-1');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.route).toBe(KEEP);
    expect(client.calls[0]?.body).toEqual({
      harness: 'claude-code',
      runtime: 'claude-default',
      conversations: [{ id: 'a', start: false }],
    });
  });

  it('refuses a keep that starts more than ten before sending it', async () => {
    const client = fakeClient({});
    const conversations = Array.from({ length: 11 }, (_, index) => ({ id: `c${index}`, start: true }));
    await expect(keepConversations(client, { harness: 'claude-code', runtime: 'r', conversations })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });
});
