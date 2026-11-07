/**
 * Ferret views for the notification suites: the shape the notification ledger reads (`NotifiedView`), whose status
 * may be one a session list says about a waiting, finished or dead ferret — not only Ferrets' four.
 */

import type { NotifiedStatus, NotifiedView } from '../../../app/lib/notification-ledger.ts';
import type { SessionConfig } from '../../../app/shell.ts';

export interface NotifiedViewOverrides {
  readonly config?: Partial<SessionConfig>;
  readonly state?: Partial<NotifiedView['state']>;
}

/** A working ferret on turn 4, overridable field by field. */
export const notifiedView = (id: string, overrides: NotifiedViewOverrides = {}): NotifiedView => ({
  config: {
    id,
    name: `Session ${id}`,
    mode: 'auto',
    cwd: `/work/${id}`,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:01.000Z',
    ...overrides.config,
  },
  state: { status: 'running' as NotifiedStatus, turn: 4, ...overrides.state },
});
