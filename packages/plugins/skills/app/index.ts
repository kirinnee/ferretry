import type { AppComponent, PanelProps, PluginClient, RendererProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type Surfaces = {
  readonly panels: Record<string, AppComponent<PanelProps>>;
  readonly settings: Record<string, AppComponent<SettingsProps>>;
  readonly renderers: Record<string, AppComponent<RendererProps>>;
};

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./views/${'surfaces'}.tsx`);

/**
 * Skills' app half: the Skills tab of a ferret's context, the Settings inventory, and the `/name` / `$name` reference
 * renderers. Every surface reads and writes through the one generated client by route key.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    let surfaces: Promise<Surfaces> | undefined;
    const surfacesOf = (): Promise<Surfaces> => {
      surfaces ??= loadSurfaces().then(module => (module.createSurfaces as (client: PluginClient) => Surfaces)(client));
      return surfaces;
    };
    const renderer = (key: 'reference:/' | 'reference:$') =>
      lazyComponent<RendererProps>(async () => (await surfacesOf()).renderers[key] as AppComponent<RendererProps>);
    return {
      panels: {
        skills: lazyComponent<PanelProps>(async () => (await surfacesOf()).panels.skills as AppComponent<PanelProps>),
      },
      settings: {
        skills: lazyComponent<SettingsProps>(
          async () => (await surfacesOf()).settings.skills as AppComponent<SettingsProps>,
        ),
      },
      renderers: { 'reference:/': renderer('reference:/'), 'reference:$': renderer('reference:$') },
    };
  },
});
