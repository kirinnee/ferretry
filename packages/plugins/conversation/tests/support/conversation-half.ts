import type { AskAnswer, AskId } from '@ferretry/core-asks/contract';
import type { HarnessGate } from '@ferretry/core-mailbox/contract';
import type { ConversationApi } from '../../contract/index.ts';
import channel from '../../daemon/features/channel.feature.ts';
import { composeConversation } from '../../daemon/features/compose.ts';
import drafts from '../../daemon/features/drafts.feature.ts';
import hypermedia from '../../daemon/features/hypermedia.feature.ts';
import prompts from '../../daemon/features/prompts.feature.ts';
import questions from '../../daemon/features/questions.feature.ts';
import queue from '../../daemon/features/queue.feature.ts';
import turns from '../../daemon/features/turns.feature.ts';
import type { ConversationContext } from '../../daemon/features/types.ts';
import type { ReadingHalf } from '../../daemon/reading.ts';
import type { TranscriptEvent } from '../../daemon/seams/transcript-types.ts';

/**
 * Conversation's part a on its own: every feature except `reading` and `ferret-changes`, composed over the ports a test
 * hands it, the way `daemon/index.ts` composes them in production. Part b is a stand-in that holds only what part a
 * reads of it (the stored originals and a Codex transcript's tail).
 */
export function buildConversationA(deps: {
  readonly kernel: ConversationContext['kernel'];
  readonly ferrets: ConversationContext['ferrets'];
  readonly asks: ConversationContext['asks'];
  readonly hooks: ConversationContext['hooks'];
  readonly gate: HarnessGate;
  readonly mailbox: ConversationContext['mailbox'];
  readonly attachments?: { readonly download: ReadingHalf['download'] };
  readonly questionEvents?: (
    ferret: string,
    limit?: number,
  ) => Promise<readonly TranscriptEvent[] | 'unreadable' | undefined>;
  readonly questionFile?: (ferret: string) => Promise<string | undefined>;
}) {
  const context: ConversationContext = {
    daemon: undefined as never,
    kernel: deps.kernel,
    ferrets: deps.ferrets,
    asks: deps.asks,
    hooks: deps.hooks,
    mailbox: deps.mailbox,
    gate: deps.gate,
    clock: { now: () => deps.kernel.clock.now() },
    late: {
      reading: {
        questionEvents: deps.questionEvents ?? (async () => undefined),
        questionFile: deps.questionFile ?? (async () => undefined),
        download: deps.attachments?.download ?? (async () => undefined),
      } as unknown as ReadingHalf,
    },
  };
  const served = composeConversation([channel, drafts, hypermedia, prompts, questions, queue, turns], context);
  const taken = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`part a serves no ${what}`);
    return value;
  };
  const questionSource = taken(served.hooks['ask.sources:question'], 'ask.sources:question');
  return {
    api: served.port as ConversationApi,
    routes: served.routes,
    sockets: served.sockets,
    onAskAnswered: async (answered: { readonly ferret: string; readonly askId: AskId }) =>
      await taken(served.subscribers['asks.answered'], 'asks.answered')(answered as never),
    onAsksChanged: async () => await taken(served.subscribers['asks.changed'], 'asks.changed')({} as never),
    withdrawQuestion: async (ferret: string) => await context.late.questions?.withdraw(ferret),
    applyQuestionAnswer: async (answer: AskAnswer) =>
      await (questionSource as { apply(answer: AskAnswer): Promise<'applied' | { readonly refused: string }> }).apply(
        answer,
      ),
    stop: served.stop,
  };
}
