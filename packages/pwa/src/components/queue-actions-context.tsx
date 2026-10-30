import { createContext, useContext } from 'react';
import type { QueueActions } from '../lib/send-queue.ts';

/**
 * Edit and Cancel for a message the durable queue still holds. The workspace (App) owns the client and the
 * refresh, so the bubble reaches them through this context instead of threading two more props down the
 * chat page. `null` outside a session workspace — and for a daemon with no queue — means the bubble offers
 * neither.
 */
export const QueueActionsContext = createContext<QueueActions | null>(null);

export const useQueueActions = (): QueueActions | null => useContext(QueueActionsContext);
