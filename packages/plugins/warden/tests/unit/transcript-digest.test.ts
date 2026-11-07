import { describe, expect, test } from 'bun:test';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { err, ok } from '@ferretry/std';
import { LIVENESS_TAIL_EVENTS, transcriptDigest } from '../../daemon/fleet.ts';

const F1 = ferretId('f1');

/** A Conversation whose log tail (every event kind, masked) is `log`, and which records the limits it was asked. */
function withLog(log: () => string) {
  const asked: (number | undefined)[] = [];
  const conversation: ConversationApi = {
    ...fakeConversation(),
    transcriptLog: async (ferret, options) => {
      asked.push(options?.limit);
      return ok({ v: 1, ferret, log: log() });
    },
  };
  return { conversation, asked };
}

describe('the transcript digest the liveness monitor folds (today’s hash of operatorReads.logs(id, 20))', () => {
  test('a stretch that writes only reasoning moves it, where the message/tool event tail would not', async () => {
    let log = 'user: open the PR\nassistant: opened it';
    const { conversation, asked } = withLog(() => log);

    const before = await transcriptDigest(conversation, F1);
    log += '\n(thinking) weighing the next step';
    const after = await transcriptDigest(conversation, F1);

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(asked).toEqual([LIVENESS_TAIL_EVENTS, LIVENESS_TAIL_EVENTS]);
  });

  test('an unchanged log is the same digest, and only the digest is answered, never the text', async () => {
    const { conversation } = withLog(() => 'assistant: [redacted:GH_TOKEN] done');

    const first = await transcriptDigest(conversation, F1);
    const second = await transcriptDigest(conversation, F1);

    expect(first).toBe(second);
    expect(first).not.toContain('redacted');
    expect(first).not.toContain('done');
  });

  test('a refused, throwing or missing log read is no evidence (undefined), never a digest of nothing', async () => {
    const base = fakeConversation();
    const refused: ConversationApi = {
      ...base,
      transcriptLog: async () => err({ code: 'not_found', message: 'no ferret f1' }),
    };
    const throwing: ConversationApi = {
      ...base,
      transcriptLog: async () => {
        throw new Error('the transcript cannot be read');
      },
    };
    const { transcriptLog: _absent, ...without } = base;

    expect(await transcriptDigest(refused, F1)).toBeUndefined();
    expect(await transcriptDigest(throwing, F1)).toBeUndefined();
    expect(await transcriptDigest(without, F1)).toBeUndefined();
  });
});
