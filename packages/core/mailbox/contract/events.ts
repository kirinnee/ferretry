import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import { defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { QueueChangeSchema } from './wire-send.ts';

/**
 * Wake-up, published after the write landed (§7.4). The truth is the queue (`MailboxApi.queue`); the event is relied on
 * by none. The name is the wire's: it stays `conversation.queue-changed` for every app and CLI that listens.
 */
export const QueueChanged = defineEvent(
  'conversation.queue-changed',
  z.strictObject({ ferret: FerretIdSchema, message: z.string().min(1), change: QueueChangeSchema }),
);
