// "MESSAGE QUEUE" IN A FERRET'S ACTIONS MENU: the link from the chat header to that ferret's queue view.

import { ListChecks } from 'lucide-react';
import type { SessionActionContribution } from '../session-actions/registry.ts';

export const QUEUE_ACTION_ID = 'message-queue';

export const queueContribution = (waiting: number, open: () => void): SessionActionContribution<unknown> => ({
  group: 'session',
  order: 39,
  build: () => ({
    kind: 'run',
    id: QUEUE_ACTION_ID,
    label: 'Message queue',
    icon: ListChecks,
    ...(waiting === 0 ? {} : { detail: `${waiting} waiting` }),
    run: open,
  }),
});
