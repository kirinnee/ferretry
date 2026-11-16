/**
 * Terminals' own `ferret.side` panels (§2.3): the terminal deck (with the phone key bar), the Console (the agent's own
 * pane, live, from today's Console tab) and the Processes list. Each reads through this half's client by route key.
 */

import type { PanelIntent, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, type ReactNode, useMemo, useState } from 'react';
import { SessionTerminalDeck, type TerminalDeckDependencies } from '../../components/session-terminal-deck.tsx';
import { type DaemonConnection, daemonSessionScope } from '../../shell.ts';
import { ConsoleSurface } from './console-surface.tsx';
import { usePhoneKeyBar } from './phone/use-phone-key-bar.tsx';
import { ProcessesSurface } from './processes-surface.tsx';
import { useSessionProcesses } from './use-session-processes.ts';

interface PanelBase {
  readonly connection: DaemonConnection;
  readonly subject: string;
  readonly client: Pick<PluginClient, 'call'>;
}

const column = (children: ReactNode): ReactNode =>
  createElement('div', { className: 'flex h-full min-h-0 min-w-0 flex-col', 'data-terminals-panel': '' }, children);

/** The terminal deck; on a phone the key bar sits under it and types through the deck's own port. */
export function TerminalsPanel({
  connection,
  subject,
  dependencies,
  intent,
}: Omit<PanelBase, 'client'> & { readonly dependencies: TerminalDeckDependencies; readonly intent?: PanelIntent }) {
  const keys = usePhoneKeyBar();
  const scope = useMemo(() => daemonSessionScope(connection, subject), [connection, subject]);
  return column([
    createElement(
      'div',
      { key: 'deck', className: 'flex min-h-0 flex-1 flex-col' },
      createElement(SessionTerminalDeck, {
        connection,
        scope,
        dependencies,
        interceptInput: keys.interceptInput,
        onInputPort: keys.onInputPort,
        ...(intent === undefined ? {} : { intent }),
      }),
    ),
    createElement('div', { key: 'bar' }, keys.bar),
  ]);
}

/** The Console: the agent's own pane, live (the pane snapshot), typeable, with the phone key bar on a phone. */
export function ConsolePanel({ connection, subject, client }: PanelBase) {
  const keys = usePhoneKeyBar();
  const scope = useMemo(() => daemonSessionScope(connection, subject), [connection, subject]);
  return column([
    createElement(ConsoleSurface, {
      key: 'console',
      connection,
      client,
      scope,
      interceptInput: keys.interceptInput,
      onInputPort: keys.onInputPort,
    }),
    createElement('div', { key: 'bar' }, keys.bar),
  ]);
}

/** What runs under the ferret, polled through this half's client. */
export function ProcessesPanel({ connection, subject, client }: PanelBase) {
  const scope = useMemo(() => daemonSessionScope(connection, subject), [connection, subject]);
  const { state, refresh } = useSessionProcesses({ connection, scope, client, visible: true });
  const [openId, setOpenId] = useState<string | null>(null);
  return createElement(ProcessesSurface, {
    connection,
    client,
    scope,
    state,
    openId,
    onOpenChange: setOpenId,
    onRefresh: refresh,
  });
}
