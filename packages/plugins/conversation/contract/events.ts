import { defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema } from './core.ts';
import { QueueChangeSchema } from './wire-send.ts';

/** Wake-ups, published after the write landed (§7.4). The truth is `ConversationApi`; none is relied on. */
export const QueueChanged = defineEvent(
  'conversation.queue-changed',
  z.strictObject({ ferret: FerretIdSchema, message: z.string().min(1), change: QueueChangeSchema }),
);
export const MessageSent = defineEvent(
  'conversation.message-sent',
  z.strictObject({ ferret: FerretIdSchema, sendId: z.string().min(1) }),
);
export const QuestionAsked = defineEvent(
  'conversation.question-asked',
  z.strictObject({ ferret: FerretIdSchema, toolUseId: z.string().min(1) }),
);
export const QuestionAnswered = defineEvent(
  'conversation.question-answered',
  z.strictObject({ ferret: FerretIdSchema, toolUseId: z.string().min(1) }),
);
export const DraftChanged = defineEvent(
  'conversation.draft-changed',
  z.strictObject({ ferret: FerretIdSchema, slot: z.string().min(1) }),
);
export const LinkKept = defineEvent(
  'conversation.link-kept',
  z.strictObject({ ferret: FerretIdSchema, link: z.string().min(1) }),
);
