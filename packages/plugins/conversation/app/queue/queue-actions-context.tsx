import { createContext, useContext } from 'react';
import type { QueueActions } from './send-queue.ts';

/**
 * Edit and Cancel for a message the durable queue still holds. The chat screen owns the client and the
 * refresh, so the bubble reaches them through this context instead of threading two more props down the
 * chat page. `null` outside a ferret's chat means the bubble offers neither.
 */
export const QueueActionsContext = createContext<QueueActions | null>(null);

export const useQueueActions = (): QueueActions | null => useContext(QueueActionsContext);
