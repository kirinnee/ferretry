/**
 * EVERY SURFACE MCP DRAWS, built once per daemon from the generated client: the `mcp-servers` panel on `ferret.side` (the
 * servers of the ferret the panel sits beside) and the `mcp` Settings tab (the servers of the machine). Both read and act
 * through the half's own client by route key; no token, secret value or program argument reaches either (docs/mcp-oauth.md).
 */
import type { AppComponent, PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { ContextNote } from '@ferretry/app/ui';
import { McpServersPanel } from './servers-panel.tsx';
import { McpSettings } from './servers-settings.tsx';

const mcpServersPanel = (client: PluginClient): AppComponent<PanelProps> =>
  function McpServers({ subject }: PanelProps): ReactNode {
    if (subject === undefined) return <ContextNote>Pick a ferret to see its MCP servers.</ContextNote>;
    return <McpServersPanel client={client} ferretId={subject} />;
  };

const mcpSettings = (client: PluginClient): AppComponent<SettingsProps> =>
  function McpServersSettings(): ReactNode {
    return <McpSettings client={client} />;
  };

export interface McpSurfaces {
  readonly panels: { readonly 'mcp-servers': AppComponent<PanelProps> };
  readonly settings: { readonly mcp: AppComponent<SettingsProps> };
}

export const createSurfaces = (client: PluginClient): McpSurfaces => ({
  panels: { 'mcp-servers': mcpServersPanel(client) },
  settings: { mcp: mcpSettings(client) },
});
