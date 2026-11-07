import type { AppComponent, PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type Surfaces = {
  readonly panels: Record<string, AppComponent<PanelProps>>;
  readonly settings: Record<string, AppComponent<SettingsProps>>;
};

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./views/${'surfaces'}.tsx`);

/**
 * MCP's app half: the `mcp-servers` panel on a ferret's side (Info › Folder › MCP and the Tools row) and the Settings
 * › MCP servers tab. Every surface reads and acts through the one generated client; signing in to a remote server is
 * the daemon's OAuth client at work and the app never holds a token (docs/mcp-oauth.md).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    let surfaces: Promise<Surfaces> | undefined;
    const surfacesOf = (): Promise<Surfaces> => {
      surfaces ??= loadSurfaces().then(module => (module.createSurfaces as (client: PluginClient) => Surfaces)(client));
      return surfaces;
    };
    return {
      panels: {
        'mcp-servers': lazyComponent<PanelProps>(
          async () => (await surfacesOf()).panels['mcp-servers'] as AppComponent<PanelProps>,
        ),
      },
      settings: {
        mcp: lazyComponent<SettingsProps>(async () => (await surfacesOf()).settings.mcp as AppComponent<SettingsProps>),
      },
    };
  },
});
