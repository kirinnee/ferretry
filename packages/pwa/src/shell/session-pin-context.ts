/**
 * HOW A ROW ASKS THE APP TO PIN OR UNPIN ITS FERRET. The hover pin on a desktop row reaches the app's
 * clients through context, as the row menu does (`SessionMenuContext`). Absent means no pin control.
 */

import type { SessionView } from '@ferretry/protocol';
import { createContext } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';

export type TogglePin = (target: { readonly view: SessionView; readonly daemonId: DaemonId }) => void;

export const SessionPinContext = createContext<TogglePin | undefined>(undefined);
