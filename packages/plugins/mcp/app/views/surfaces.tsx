/**
 * EVERY SURFACE MCP DRAWS, built once per daemon from the generated client: the `mcp-servers` panel on `ferret.side` (the
 * servers of the ferret the panel sits beside) and the `mcp` Settings tab (the servers of the machine). Both read and act
 * through the half's own client by route key; no token, secret value or program argument reaches either (docs/mcp-oauth.md).
 */
import type { AppComponent, PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { controlState, useViewPlace } from '@ferretry/app';
import { ContextNote } from '@ferretry/app/ui';
import { ADD_ROUTES } from '../lib/client.ts';
import { createAddMcpRowPanel } from './add-mcp-row.tsx';
import { createComponentStatusPanel } from './component-status.tsx';
import { McpServersPanel } from './servers-panel.tsx';
import { McpSettings } from './servers-settings.tsx';

/**
 * Whether "Add…" is offered: the view's place (shell contract S1) says what this device may do with the two routes
 * "Add…" writes through, and a control the daemon said it may not have is not drawn (a control that is still being
 * read, or whose answer was unreadable, is not offered either: the panel has only on or off). Outside a per-daemon view
 * (a suite) there is no place, and the daemon's own refusal is the answer.
 */
function useCanAdd(): boolean {
  const place = useViewPlace();
  if (place === null) return true;
  return Object.values(ADD_ROUTES).some(route => {
    const state = controlState(place.authorityOf(route));
    return state.shown && state.enabled;
  });
}

const mcpServersPanel = (client: PluginClient): AppComponent<PanelProps> =>
  function McpServers({ subject }: PanelProps): ReactNode {
    const canControl = useCanAdd();
    if (subject === undefined) return <ContextNote>Pick a ferret to see its MCP servers.</ContextNote>;
    return <McpServersPanel canControl={canControl} client={client} ferretId={subject} />;
  };

const mcpSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function McpServersSettings(): ReactNode {
    return <McpSettings client={client} />;
  };

export interface McpSurfaces {
  readonly panels: {
    readonly 'mcp-servers': AppComponent<PanelProps>;
    readonly 'add-mcp-row': AppComponent<PanelProps>;
    readonly 'component-status': AppComponent<PanelProps>;
  };
  readonly settings: { readonly mcp: AppComponent<SettingsProps> };
}

export const createSurfaces = (client: PluginClient): McpSurfaces => ({
  panels: {
    'mcp-servers': mcpServersPanel(client),
    'add-mcp-row': createAddMcpRowPanel(client),
    'component-status': createComponentStatusPanel(client),
  },
  settings: { mcp: mcpSettings(client) },
});
