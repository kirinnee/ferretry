/** EVERY SURFACE CONNECTOR DRAWS, built once per daemon from the generated client: the `connector` Settings tab. */
import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { ConnectorSettings } from './connector-settings.tsx';

export interface ConnectorSurfaces {
  readonly settings: { readonly connector: AppComponent<SettingsProps> };
}

export const createSurfaces = (client: PluginClient): ConnectorSurfaces => ({
  settings: {
    connector: function ConnectorTab(): ReactNode {
      return <ConnectorSettings client={client} />;
    },
  },
});
