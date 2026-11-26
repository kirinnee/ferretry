import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

interface Surfaces {
  readonly settings: Record<string, AppComponent<SettingsProps>>;
}

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./views/${'surfaces'}.tsx`);

/**
 * Connector (app half): Settings › Claude connector — the switch, the address Claude is given, the sign-ins waiting for the
 * owner's passkey, and the connected apps. Every surface reads and acts through the one generated client; nothing the
 * connector keeps secret (a token, a code, a handle) is ever on the wire to the app (docs/mcp-connector.md).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    let surfaces: Promise<Surfaces> | undefined;
    const surfacesOf = (): Promise<Surfaces> => {
      surfaces ??= loadSurfaces().then(module => (module.createSurfaces as (client: PluginClient) => Surfaces)(client));
      return surfaces;
    };
    return {
      settings: {
        connector: lazyComponent<SettingsProps>(
          async () => (await surfacesOf()).settings.connector as AppComponent<SettingsProps>,
        ),
      },
    };
  },
});
