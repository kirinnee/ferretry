/**
 * The ferret's header as panels on `ferret.toolbar`: its name, its status and Actions ▾. Each is made once per daemon from
 * the half's own client and reads the ferret named by the shell's `subject`. The frame around them is the host's
 * (Conversation's chat screen mounts the slot).
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { FerretName } from '../features/header/name-panel.tsx';
import { ActionsPanel } from '../features/header/actions-panel.tsx';
import { FerretStatus } from '../features/header/status-panel.tsx';
import '../features/header/ferret-actions.css';
import type { LiveFerretsClient } from '../lib/client.ts';
import { useFerret } from '../lib/ferret-read.ts';
import { useLayoutMode } from '../ui.ts';

export const createNamePanel =
  (client: LiveFerretsClient): AppComponent<PanelProps> =>
  ({ subject }) => {
    const { read } = useFerret(client, subject);
    const compact = useLayoutMode() === 'drawer';
    return read.kind === 'ready' ? <FerretName compact={compact} ferret={read.ferret} /> : null;
  };

export const createStatusPanel =
  (client: LiveFerretsClient): AppComponent<PanelProps> =>
  ({ subject }) => {
    const { read } = useFerret(client, subject);
    const compact = useLayoutMode() === 'drawer';
    return read.kind === 'ready' ? <FerretStatus compact={compact} ferret={read.ferret} /> : null;
  };

export const createActionsPanel =
  (client: LiveFerretsClient): AppComponent<PanelProps> =>
  ({ subject }) => <ActionsPanel client={client} subject={subject} />;
