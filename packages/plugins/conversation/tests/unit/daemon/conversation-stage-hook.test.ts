import { describe, expect, test } from 'bun:test';
import { FakeMailbox } from '@ferretry/core-mailbox/contract/testing';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import {
  CONVERSATION_STAGE_KEY,
  ConversationStage,
  type ConversationStageSource,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

/**
 * O8-12, Conversation's end of `conversation.stage`: the REAL daemon half, built on the test host, provides it under its
 * one key. Ferrets' end (a start that names a conversation stages first and is refused without it) is pinned in its
 * package (`conversation-start.test.ts`); the copy itself in `links/service.test.ts` for Claude and Codex.
 */

type Half = { readonly hooks?: Readonly<Record<string, unknown>> };

async function builtHalf(): Promise<Half> {
  let half: Half | undefined;
  const build = daemon.build;
  if (build === undefined) throw new Error('the conversation daemon half has no build');
  const captured = {
    ...daemon,
    build: (ctx: Parameters<typeof build>[0]) => {
      const built = build(ctx);
      half = built as Half;
      return built;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [captured],
    fakes: { mailbox: new FakeMailbox(), ferrets: new FakeFerrets(), asks: new FakeAsks() },
  });
  await host.stop();
  if (half === undefined) throw new Error('the host did not build the conversation half');
  return half;
}

describe('O8-12 Conversation provides conversation.stage', () => {
  test('the manifest takes conversation.stage as its one provider, under the hook’s one key', () => {
    expect(manifest.hooks?.takes?.filter(take => take.hook.name === ConversationStage.name)).toEqual([
      { hook: ConversationStage, key: CONVERSATION_STAGE_KEY },
    ]);
    expect(ConversationStage.mode).toBe('provide');
    expect(ConversationStage.mode === 'provide' && ConversationStage.takers).toEqual(['conversation']);
  });

  test('the built half’s provider refuses, in a plain sentence, a conversation its index does not hold', async () => {
    const half = await builtHalf();
    const source = half.hooks?.[`${ConversationStage.name}:${CONVERSATION_STAGE_KEY}`] as
      | ConversationStageSource
      | undefined;
    expect(typeof source?.stage).toBe('function');
    for (const harness of ['claude-code', 'codex'] as const) {
      const refused = await source?.stage({ harness, conversation: 'no-such-conversation' });
      expect(refused).toEqual({
        ok: false,
        error: { code: 'not_found', reason: `No ${harness} conversation no-such-conversation is on this machine.` },
      });
    }
  });
});
