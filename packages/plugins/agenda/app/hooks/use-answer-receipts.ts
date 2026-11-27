/**
 * The answers this device has given and not yet seen settle (`AnswerReceipts`), as the view that draws an item's
 * conversation reads them: the Inbox's open item and the chat's item view alike, whether or not an Inbox is mounted.
 */

import { useSyncExternalStore } from 'react';
import type { DeferredAgendaState } from '../lib/agenda-inbox.ts';
import { answerReceipts } from '../lib/answer-receipts.ts';

export const useAnswerReceipts = (): DeferredAgendaState =>
  useSyncExternalStore(answerReceipts.subscribe, answerReceipts.getSnapshot, answerReceipts.getSnapshot);
