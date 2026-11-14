import type {
  AppComponent,
  PanelProps,
  PluginClient,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { agendaHooks } from './agenda-hooks.ts';
import { boardForFerretCommands, boardPlaces } from './command-bar.ts';
import { lazyComponent } from './lazy.ts';

type Surfaces = {
  readonly screens: Record<string, AppComponent<ScreenProps>>;
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
 * Board's app half: the board and one card as screens, a ferret's cards and a card's progress as panels, the Board
 * Settings tab, and the renderers for the `card` ask and a `&F12` reference. Every surface reads the board through
 * the one generated client and draws it read-only: a card never asks, and the owner answers in the Agenda (#1552).
 * The answer that moves a card is Agenda's to draw and Board's to make: the half provides Agenda's app hooks
 * (`agenda-hooks.ts`) over the same client and runtime as its views.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => {
      let surfaces: Promise<Surfaces> | undefined;
      const surfacesOf = (): Promise<Surfaces> => {
        surfaces ??= loadSurfaces().then(module =>
          (module.createSurfaces as (client: PluginClient) => Surfaces)(client),
        );
        return surfaces;
      };
      const screen = (id: 'board' | 'card') =>
        lazyComponent<ScreenProps>(async () => (await surfacesOf()).screens[id] as AppComponent<ScreenProps>);
      const panel = (id: 'cards-of-ferret' | 'card-progress') =>
        lazyComponent<PanelProps>(async () => (await surfacesOf()).panels[id] as AppComponent<PanelProps>);
      const renderer = (key: 'ask:card' | 'reference:&') =>
        lazyComponent<RendererProps>(async () => (await surfacesOf()).renderers[key] as AppComponent<RendererProps>);
      return {
        screens: { board: screen('board'), card: screen('card') },
        panels: { 'cards-of-ferret': panel('cards-of-ferret'), 'card-progress': panel('card-progress') },
        settings: {
          board: lazyComponent<SettingsProps>(
            async () => (await surfacesOf()).settings.board as AppComponent<SettingsProps>,
          ),
        },
        renderers: { 'ask:card': renderer('ask:card'), 'reference:&': renderer('reference:&') },
      };
    },
  }),
  { commands: context => [boardPlaces(context), boardForFerretCommands(context)], hooks: agendaHooks },
);
